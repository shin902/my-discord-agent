import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BotProfile } from "../config/bots.js";
import type { GroupConfig } from "../config/groups.js";
import {
  acquireInferenceLock,
  createHeldInferenceResource,
  type HeldInferenceResource,
} from "../queue/inference-lock.js";

const state = vi.hoisted(() => ({ repository: undefined as unknown }));
vi.mock("./manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../config/bots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/bots.js")>()),
  loadBotRegistry: vi.fn(),
}));
vi.mock("../config/groups.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/groups.js")>()),
  findGroupByName: vi.fn(),
  findGroupByChannelId: vi.fn(),
}));
vi.mock("../config/group-config.js", () => ({
  loadGroupSystemPrompt: vi.fn().mockResolvedValue("Main Agent role"),
}));
vi.mock("../config/default-model.js", () => ({
  resolveModelConfig: vi.fn(async (model: unknown) => model),
}));
vi.mock("../config/providers.js", () => ({
  resolveProviderLockTarget: vi
    .fn()
    .mockResolvedValue({ resource: "provider-a", concurrency: "parallel" }),
}));
vi.mock("../discord/client.js", () => ({
  getDiscordClientForGroupName: vi.fn().mockResolvedValue({
    isReady: () => false,
    channels: {
      cache: new Map(),
      fetch: vi.fn().mockResolvedValue(null),
    },
  }),
}));
vi.mock("../queue/repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../queue/repository.js")>()),
  getQueueRepository: () => state.repository,
}));

const sessions = await mkdtemp(join(tmpdir(), "bot-task-prompts-"));
vi.stubEnv("SESSIONS_DIR", sessions);
const { appendMessage, loadMessages, readOwnerSessions } = await import(
  "./session.js"
);
const { resolveProviderLockTarget } = await import("../config/providers.js");
const { sendMessage } = await import("./manager.js");
const { handleBotToolRequest } = await import("./bot-orchestration.js");
const { executeBotCommand } = await import(
  "../application/discord-command-service.js"
);
const { openRuntimeDb, QueueRepository } = await import(
  "../queue/repository.js"
);
const { processMessage } = await import("../queue/poller.js");
const { loadBotRegistry } = await import("../config/bots.js");
const { loadGroupSystemPrompt } = await import("../config/group-config.js");
const { findGroupByName, findGroupByChannelId } = await import(
  "../config/groups.js"
);

afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(sessions, { recursive: true, force: true });
});

const group: GroupConfig = {
  name: "group",
  channels: [],
  model: { provider: "group-provider", modelId: "group-model" },
  tools: ["date"],
  skills: ["group-skill"],
  mounts: [{ host: "/shared", container: "/workspace/shared", readOnly: true }],
};
const profile: BotProfile = {
  group: group.name,
  description: "Caller-facing description A",
  instructions: "Bot role A",
  tools: ["read", "bot"],
};
let repository: InstanceType<typeof QueueRepository>;
let requestNumber: number;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(resolveProviderLockTarget).mockResolvedValue({
    resource: "provider-a",
    concurrency: "parallel",
  });
  await rm(join(sessions, group.name), { recursive: true, force: true });
  repository = new QueueRepository(openRuntimeDb(":memory:"));
  state.repository = repository;
  requestNumber = 0;
  vi.mocked(loadBotRegistry).mockResolvedValue({ worker: profile });
  vi.mocked(findGroupByName).mockResolvedValue(group);
  vi.mocked(findGroupByChannelId).mockResolvedValue({
    group,
    channel: {
      channelId: "channel",
      sessionMode: "shared",
      tools: ["bash"],
      model: { provider: "channel-provider", modelId: "channel-model" },
    },
  });
  vi.mocked(sendMessage).mockResolvedValue("result");
});
afterEach(() => repository.close());

type Surface = "discord" | "direct";
async function invoke(
  surface: Surface,
  action: "run" | "resume",
  handle = "",
  idempotencyKey = `request-${++requestNumber}`,
  heldResource?: HeldInferenceResource,
): Promise<string> {
  if (surface === "discord") {
    const result = await executeBotCommand({
      discordBotId: "personal",
      channelId: "channel",
      routingChannelId: "channel",
      botId: "worker",
      action,
      prompt: "do work",
      sessionHandle: handle,
      idempotencyKey,
    });
    expect(result.accepted).toBe(true);
    return result.content.split("Task Session: ")[1];
  }
  const req = Object.assign(new EventEmitter(), {
    async *[Symbol.asyncIterator]() {
      yield JSON.stringify({
        groupName: group.name,
        bot: "worker",
        action,
        prompt: "do work",
        ...(handle ? { session: handle } : {}),
      });
    },
  });
  const res = Object.assign(new EventEmitter(), {
    headersSent: false,
    writableEnded: false,
    writeHead: vi.fn(),
    end: vi.fn(),
  });
  await handleBotToolRequest(
    req as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    group.name,
    heldResource,
  );
  const body = JSON.parse(res.end.mock.calls[0][0]);
  if (body.error) throw new Error(body.error);
  return body.session;
}

async function processQueued() {
  const claim = repository.claim("test-worker");
  if (!claim) throw new Error("expected queued task");
  await processMessage(claim.job);
  return repository.get(claim.job.id);
}

function task(handle: string) {
  const session = repository
    .listBotTaskSessions(group.name, "worker")
    .find((session) => session.handle === handle);
  if (!session) throw new Error("expected task session");
  return session;
}

async function expectSnapshot(handle: string, content: string) {
  const db = new Database(join(sessions, group.name, "sessions.sqlite"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    expect(
      db
        .prepare("SELECT agent_id FROM sessions WHERE id=?")
        .get(task(handle).sessionId),
    ).toEqual({ agent_id: "worker" });
  } finally {
    db.close();
  }
  expect(
    [...readOwnerSessions(group.name, "worker")].some(
      ({ sessionId }) => sessionId === task(handle).sessionId,
    ),
  ).toBe(false);
  expect(
    await loadMessages(group.name, task(handle).sessionId, "worker"),
  ).toEqual([
    expect.objectContaining({
      role: "custom",
      customType: "system-prompt-snapshot",
      content,
      display: false,
    }),
  ]);
}

function expectExecution(content: string) {
  const options = vi.mocked(sendMessage).mock.lastCall?.[3];
  expect(options).toMatchObject({
    agentId: "worker",
    systemPromptSnapshotContent: content,
    systemPromptSnapshotPresent: true,
    enableBotTool: false,
  });
  expect(options?.systemPromptAppend).toBeUndefined();
  return options;
}

describe("Bot Task Session role snapshots", () => {
  it.each<Surface>([
    "discord",
    "direct",
  ])("%s freezes A before admission, resumes A after profile changes, and starts new tasks with B", async (surface) => {
    const handle = await invoke(surface, "run");
    // The real session DB already contains A, before a queued worker can run.
    await expectSnapshot(handle, "Bot role A");
    vi.mocked(loadBotRegistry).mockResolvedValue({
      worker: {
        ...profile,
        description: "Caller-facing description B",
        instructions: "Bot role B",
        model: { provider: "bot-provider", modelId: "bot-model" },
        tools: ["bash", "bot"],
        skills: ["bot-skill"],
      },
    });
    if (surface === "discord") {
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await processQueued()).toMatchObject({
        status: "completed",
        systemPromptSnapshotContent: "Bot role A",
      });
    }
    expectExecution("Bot role A");

    await invoke(surface, "resume", handle);
    if (surface === "discord") await processQueued();
    expect(expectExecution("Bot role A")?.configOverride).toEqual({
      model: { provider: "bot-provider", modelId: "bot-model" },
      tools: ["bash", "bot"],
      skills: ["bot-skill"],
      mounts: group.mounts,
    });
    await expectSnapshot(handle, "Bot role A");
    await appendMessage(
      group.name,
      task(handle).sessionId,
      {
        role: "user",
        content: "follow-up",
        timestamp: 1,
      },
      "worker",
    );
    expect(
      [...readOwnerSessions(group.name, "worker")].some(
        ({ sessionId, message }) =>
          sessionId === task(handle).sessionId &&
          "content" in message &&
          message.content === "follow-up",
      ),
    ).toBe(true);
    await appendMessage(
      group.name,
      "main-chat",
      {
        role: "user",
        content: "main",
        timestamp: 1,
      },
      "main",
    );
    expect(
      [...readOwnerSessions(group.name, "worker")].some(
        ({ sessionId }) => sessionId === "main-chat",
      ),
    ).toBe(false);

    const newHandle = await invoke(surface, "run");
    expect(newHandle).not.toBe(handle);
    await expectSnapshot(newHandle, "Bot role B");
    if (surface === "discord") await processQueued();
    expectExecution("Bot role B");
    expect(loadGroupSystemPrompt).not.toHaveBeenCalled();
  });

  it("duplicate Discord admission keeps the original task and snapshot after a profile change", async () => {
    const handle = await invoke("discord", "run", "", "same-interaction");
    vi.mocked(loadBotRegistry).mockResolvedValue({
      worker: { ...profile, instructions: "Bot role B" },
    });
    expect(await invoke("discord", "run", "", "same-interaction")).toBe(handle);
    expect(repository.listBotTaskSessions(group.name, "worker")).toHaveLength(
      1,
    );
    await expectSnapshot(handle, "Bot role A");
    const db = new Database(join(sessions, group.name, "sessions.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM sessions WHERE agent_id='worker'",
          )
          .get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
    expect([...readOwnerSessions(group.name, "worker")]).toEqual([]);
    await processQueued();
    expectExecution("Bot role A");
    expect(repository.claim("test-worker")).toBeUndefined();
  });

  it.each<Surface>([
    "discord",
    "direct",
  ])("%s preserves ambiguous legacy snapshots and rejects snapshot-less sessions without rewriting history", async (surface) => {
    for (const customType of [
      "system-prompt-snapshot",
      "agents-snapshot",
      undefined,
    ]) {
      vi.mocked(sendMessage).mockClear();
      const sessionId = `legacy-${customType ?? "missing"}`;
      const { session, admission } =
        repository.createBotTaskSessionAndAdmission({
          sessionId,
          handle: `task-${sessionId}`,
          groupName: group.name,
          botId: "worker",
          createdAt: new Date().toISOString(),
          preview: "legacy task",
        });
      repository.admitBotTaskSessionAdmission(admission);
      repository.completeBotTaskSessionAdmission(admission);
      if (customType) {
        await appendMessage(
          group.name,
          sessionId,
          {
            role: "custom",
            customType,
            content: "Legacy Main/group role",
            display: false,
            timestamp: 1,
          } as Parameters<typeof appendMessage>[2],
          "worker",
        );
      }
      await appendMessage(
        group.name,
        sessionId,
        {
          role: "user",
          content: "old task",
          timestamp: 2,
        },
        "worker",
      );
      const before = await loadMessages(group.name, sessionId, "worker");
      if (!customType && surface === "direct") {
        await expect(invoke(surface, "resume", session.handle)).rejects.toThrow(
          "新しいBot run",
        );
      } else {
        await invoke(surface, "resume", session.handle);
        if (surface === "discord") {
          expect(await processQueued()).toMatchObject({
            status: customType ? "completed" : "dead_letter",
          });
        }
      }
      if (customType) expectExecution("Legacy Main/group role");
      else expect(sendMessage).not.toHaveBeenCalled();
      expect(await loadMessages(group.name, sessionId, "worker")).toEqual(
        before,
      );
    }
  });
});

it("eight parents lend their slots to concurrent child calls without deadlock or exceeding resource capacity", async () => {
  vi.mocked(resolveProviderLockTarget).mockResolvedValue({
    resource: "provider-a",
    concurrency: 8,
  });
  const parents = await Promise.all(
    Array.from({ length: 8 }, () => acquireInferenceLock("provider-a", 8)),
  );
  const scopes = parents.map(() => createHeldInferenceResource("provider-a"));
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let active = 0;
  let peak = 0;
  let notifyAllStarted!: () => void;
  const allStarted = new Promise<void>((resolve) => {
    notifyAllStarted = resolve;
  });
  vi.mocked(sendMessage).mockImplementation(async () => {
    peak = Math.max(peak, ++active);
    if (active === 8) notifyAllStarted();
    try {
      await blocked;
      return "child result";
    } finally {
      active--;
    }
  });
  let ninthStarted = false;
  const ninth = acquireInferenceLock("provider-a", 8).then((release) => {
    ninthStarted = true;
    return release;
  });
  const children = scopes.flatMap((held) => [
    invoke("direct", "run", "", undefined, held),
    invoke("direct", "run", "", undefined, held),
  ]);
  try {
    await allStarted;
    expect(sendMessage).toHaveBeenCalledTimes(8);
    expect(peak).toBe(8);
    expect(ninthStarted).toBe(false);
    unblock();
    const handles = await Promise.all(children);
    expect(new Set(handles).size).toBe(16);
    expect(sendMessage).toHaveBeenCalledTimes(16);
    expect(peak).toBe(8);
    expect(ninthStarted).toBe(false);
  } finally {
    unblock();
    await Promise.allSettled(children);
    await Promise.all(scopes.map((held) => held.close()));
    parents.forEach((release) => {
      release();
    });
    (await ninth)();
  }
});
