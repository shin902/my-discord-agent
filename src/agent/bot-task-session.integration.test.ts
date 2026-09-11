import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  resolveProviderConcurrency: vi.fn().mockResolvedValue("parallel"),
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
const { appendMessage, loadMessages } = await import("./session.js");
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
  instructions: "Bot role A",
  tools: ["read", "bot"],
};
let repository: InstanceType<typeof QueueRepository>;
let requestNumber: number;

beforeEach(async () => {
  vi.clearAllMocks();
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
  expect(await loadMessages(group.name, task(handle).sessionId)).toEqual([
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
        await appendMessage(group.name, sessionId, {
          role: "custom",
          customType,
          content: "Legacy Main/group role",
          display: false,
          timestamp: 1,
        } as Parameters<typeof appendMessage>[2]);
      }
      await appendMessage(group.name, sessionId, {
        role: "user",
        content: "old task",
        timestamp: 2,
      });
      const before = await loadMessages(group.name, sessionId);
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
      expect(await loadMessages(group.name, sessionId)).toEqual(before);
    }
  });
});
