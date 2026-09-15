import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ChannelType, type Message, MessageType } from "discord.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ChannelConfig, GroupConfig } from "../config/groups.js";

const mocks = vi.hoisted(() => ({
  findGroup: vi.fn(),
  getRepo: vi.fn(),
  fetchChannel: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("../config/groups.js", () => ({
  findGroupByChannelId: mocks.findGroup,
}));
vi.mock("../queue/repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../queue/repository.js")>()),
  getQueueRepository: mocks.getRepo,
}));
vi.mock("./client.js", () => ({
  getDiscordClientForGroup: () => ({ channels: { fetch: mocks.fetchChannel } }),
}));
vi.mock("./interaction-router.js", () => ({
  createDiscordInteractionRouter: () => vi.fn(),
}));
vi.mock("../agent/manager.js", () => ({ sendMessage: mocks.sendMessage }));

let root: string;
let session: typeof import("../agent/session.js");
let ingest: typeof import("./intake.js").ingestDiscordMessage;
let backfill: typeof import("./backfill.js").backfillDiscordMessages;
let live: (message: Message) => Promise<unknown>;
let repo: import("../queue/repository.js").QueueRepository;
let group: GroupConfig;
let channel: ChannelConfig;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "discord-capture-"));
  vi.stubEnv("SESSIONS_DIR", root);
  session = await import("../agent/session.js");
  ({ ingestDiscordMessage: ingest } = await import("./intake.js"));
  ({ backfillDiscordMessages: backfill } = await import("./backfill.js"));
  const { registerHandlers } = await import("./handler.js");
  const client = { on: vi.fn(), once: vi.fn() };
  registerHandlers(client as never);
  live = client.on.mock.calls.find(([event]) => event === "messageCreate")?.[1];
});

beforeEach(async () => {
  vi.clearAllMocks();
  const { QueueRepository, openRuntimeDb } = await import(
    "../queue/repository.js"
  );
  repo = new QueueRepository(openRuntimeDb(":memory:"));
  mocks.getRepo.mockReturnValue(repo);
  channel = {
    channelId: "root",
    sessionMode: "shared",
    agentMode: "capture-only",
    requiredMention: true,
  };
  group = { name: "capture", channels: [channel] };
  mocks.findGroup.mockImplementation(async (id) =>
    id === "root" ? { group, channel } : null,
  );
});

afterEach(async () => {
  repo.close();
  await rm(path.join(root, "capture"), { recursive: true, force: true });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

function message(id: string, isThread = false): Message {
  return {
    id,
    channelId: isThread ? "thread" : "root",
    channel: { isThread: () => isThread, parentId: isThread ? "root" : null },
    type: MessageType.Default,
    author: { id: "human", bot: false },
    webhookId: null,
    content: `raw ${id}`,
    attachments: new Map(),
    createdAt: new Date(Number(id)),
    createdTimestamp: Number(id),
    client: { user: { id: "bot" } },
    mentions: { users: new Map() },
    reply: vi.fn(),
    startThread: vi.fn().mockResolvedValue({ id: "thread" }),
    fetch: vi.fn().mockResolvedValue({ thread: null }),
  } as unknown as Message;
}

function page(messages: Message[]) {
  return {
    size: messages.length,
    values: () => messages.values(),
    first: () => messages[0],
  };
}

function historyChannel(fetch: ReturnType<typeof vi.fn>) {
  return {
    id: "root",
    type: ChannelType.GuildText,
    messages: { fetch },
    threads: { fetchActive: vi.fn() },
  };
}

function expectNoRunsOrResponses(...messages: Message[]) {
  expect(repo.db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
    count: 0,
  });
  expect(
    repo.db.prepare("SELECT COUNT(*) AS count FROM deliveries").get(),
  ).toEqual({ count: 0 });
  expect(mocks.sendMessage).not.toHaveBeenCalled();
  for (const message of messages) {
    expect(message.reply).not.toHaveBeenCalled();
    expect(message.startThread).not.toHaveBeenCalled();
    expect(message.fetch).not.toHaveBeenCalled();
  }
}

describe("static capture-only Discord ingestion", () => {
  it("captures raw human messages once in the configured shared channel session, including normal-config replay", async () => {
    const input = message("1001");
    const enqueue = vi.spyOn(repo, "enqueue");
    await live(input);
    const sessionId = channel.channelId;
    expect(await session.loadMessages(group.name, sessionId)).toEqual([
      { role: "user", content: "raw 1001", timestamp: 1001 },
    ]);
    expect(await session.isSessionAgentInitialized(group.name, sessionId)).toBe(
      false,
    );
    await ingest(input, { source: "backfill" });
    channel.agentMode = "normal";
    channel.requiredMention = false;
    await ingest(input, { source: "backfill" });
    expect(await session.loadMessages(group.name, sessionId)).toHaveLength(1);
    const db = new Database(path.join(root, group.name, "sessions.sqlite"), {
      readonly: true,
    });
    expect(
      db
        .prepare(
          "SELECT json_extract(source_json, '$.kind') AS kind, json_extract(source_json, '$.sourceId') AS sourceId FROM session_entries",
        )
        .all(),
    ).toEqual([{ kind: "discord", sourceId: "1001" }]);
    db.close();
    expect(enqueue).not.toHaveBeenCalled();
    expectNoRunsOrResponses(input);
  });

  it.each([
    "live",
    "backfill",
  ] as const)("ignores child thread messages under a shared capture channel without an extra lookup during %s ingestion", async (source) => {
    channel.requiredMention = false;
    const input = message("1001", true);
    expect((await ingest(input, { source })).status).toBe("ignored");
    expect(mocks.findGroup.mock.calls).toEqual([["root"]]);
    await expect(
      stat(path.join(root, group.name, "sessions.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expectNoRunsOrResponses(input);
  });

  it("keeps reply text, attachment links and source timestamps as an ordinary user entry", async () => {
    const input = message("1001");
    Object.assign(input, {
      type: MessageType.Reply,
      content: "reply text",
      attachments: new Map([
        [
          "attachment",
          { name: "note.txt", url: "https://cdn.discordapp.com/note.txt" },
        ],
      ]),
    });
    await live(input);
    expect(await session.loadMessages(group.name, "root")).toEqual([
      {
        role: "user",
        content:
          "reply text\n\n[添付ファイル]\n- note.txt: https://cdn.discordapp.com/note.txt",
        timestamp: 1001,
      },
    ]);
    expect(
      await session.hasSessionSource(group.name, "root", {
        kind: "discord",
        sourceId: "1001",
        actorId: "human",
        messageType: 19,
      }),
    ).toBe(true);
    expectNoRunsOrResponses(input);
  });

  it("orders shared channel paginated backfill before racing live messages", async () => {
    repo.upsertDiscordCursor("root", "1000");
    let releaseFirst!: (value: ReturnType<typeof page>) => void;
    let releaseLast!: (value: ReturnType<typeof page>) => void;
    const firstPage = new Promise<ReturnType<typeof page>>((resolve) => {
      releaseFirst = resolve;
    });
    const lastPage = new Promise<ReturnType<typeof page>>((resolve) => {
      releaseLast = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(firstPage)
      .mockReturnValueOnce(lastPage);
    const historyRoot = historyChannel(fetch);
    mocks.fetchChannel.mockResolvedValue(historyRoot);
    const recovery = backfill([group], repo);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const b = message("1101");
    const c = message("1102");
    const pending = Promise.all([live(b), live(c)]);
    // Another capture channel must not be held by this root's startup scan.
    mocks.findGroup.mockImplementation(async (id) =>
      id === "other"
        ? {
            group,
            channel: {
              channelId: "other",
              sessionMode: "shared",
              agentMode: "capture-only",
            },
          }
        : { group, channel },
    );
    const other = message("2000");
    Object.assign(other, { channelId: "other" });
    await live(other);
    expect(await session.loadMessages(group.name, "root")).toEqual([]);
    expect(await session.loadMessages(group.name, "other")).toHaveLength(1);
    const older = Array.from({ length: 100 }, (_, index) =>
      message(String(1001 + index)),
    );
    releaseFirst(page(older.reverse()));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    expect(await session.loadMessages(group.name, "root")).toHaveLength(100);
    releaseLast(page([b]));
    await recovery;
    await pending;
    const history = await session.loadMessages(group.name, "root");
    expect(history.map((entry) => entry.timestamp)).toEqual(
      Array.from({ length: 102 }, (_, index) => 1001 + index),
    );
    expect(history.every((entry) => entry.role === "user")).toBe(true);
    expect(historyRoot.threads.fetchActive).not.toHaveBeenCalled();
    expectNoRunsOrResponses(...older, b, c, other);
  });

  it("does not let live captures pass failed backfill and recovers them on retry", async () => {
    repo.upsertDiscordCursor("root", "1000");
    const fetch = vi.fn().mockRejectedValue(new Error("history unavailable"));
    mocks.fetchChannel.mockResolvedValue(historyChannel(fetch));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const recovery = backfill([group], repo);
      const b = message("1002");
      await Promise.all([recovery, live(b)]);
      expect(await session.loadMessages(group.name, "root")).toEqual([]);
      expect(repo.getDiscordCursor("root")).toBe("1000");
      fetch.mockResolvedValue(page([message("1001"), b]));
      await backfill([group], repo);
      expect(
        (await session.loadMessages(group.name, "root")).map(
          (entry) => entry.timestamp,
        ),
      ).toEqual([1001, 1002]);
      expectNoRunsOrResponses(b);
    } finally {
      errors.mockRestore();
    }
  });
});
