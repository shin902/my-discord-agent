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
    startThread: vi.fn(),
    fetch: vi.fn(),
  } as unknown as Message;
}
function page(messages: Message[]) {
  return {
    size: messages.length,
    values: () => messages.values(),
    first: () => messages[0],
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

describe("shared live-only capture", () => {
  it("stores raw humans once without mentions or runs, and preserves history after returning to normal", async () => {
    const input = message("1001");
    const reply = message("1002");
    Object.assign(reply, {
      type: MessageType.Reply,
      attachments: new Map([
        [
          "file",
          { name: "note.txt", url: "https://cdn.discordapp.com/note.txt" },
        ],
      ]),
    });
    const enqueue = vi.spyOn(repo, "enqueue");
    await Promise.all([live(input), live(reply)]);
    await live(input);
    expect(await session.isSessionAgentInitialized(group.name, "root")).toBe(
      false,
    );
    channel.agentMode = "normal";
    channel.requiredMention = false;
    await ingest(input, { source: "backfill" });
    expect(await session.loadMessages(group.name, channel.channelId)).toEqual([
      { role: "user", content: "raw 1001", timestamp: 1001 },
      {
        role: "user",
        content:
          "raw 1002\n\n[添付ファイル]\n- note.txt: https://cdn.discordapp.com/note.txt",
        timestamp: 1002,
      },
    ]);
    const db = new Database(path.join(root, group.name, "sessions.sqlite"), {
      readonly: true,
    });
    expect(
      db
        .prepare("SELECT source_json FROM session_entries ORDER BY sequence")
        .all(),
    ).toEqual(
      [input, reply].map((entry) => ({
        source_json: JSON.stringify({
          kind: "discord",
          sourceId: entry.id,
          actorId: "human",
          messageType: entry.type,
          createdAt: entry.createdAt.toISOString(),
        }),
      })),
    );
    db.close();
    expect(enqueue).not.toHaveBeenCalled();
    expectNoRunsOrResponses(input, reply);
  });

  it("ignores child threads and historical messages without opening the session store", async () => {
    const child = message("1001", true);
    const historical = message("1002");
    expect((await ingest(child, { source: "live" })).status).toBe("ignored");
    expect((await ingest(historical, { source: "backfill" })).status).toBe(
      "ignored",
    );
    expect(mocks.findGroup.mock.calls).toEqual([["root"], ["root"]]);
    await expect(
      stat(path.join(root, group.name, "sessions.sqlite")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expectNoRunsOrResponses(child, historical);
  });

  it.each([
    "absent",
    "empty",
    "old",
  ])("skips capture downtime through normal restart with a %s cursor, then resumes normal backfill", async (state) => {
    if (state === "empty") repo.initializeDiscordCursor("root");
    if (state === "old") repo.upsertDiscordCursor("root", "1000");
    await backfill([group], repo);
    // No Discord history/channel fetch at all (also works for shared DMs).
    expect(mocks.fetchChannel).not.toHaveBeenCalled();
    expect(repo.isDiscordCursorInitialized("root")).toBe(false);
    const captured = message("1001");
    await live(captured);
    expect(repo.getDiscordCursor("root")).toBeUndefined();
    expectNoRunsOrResponses(captured);

    // Stop in capture mode, then restart directly in normal mode. 1002 was
    // posted while stopped: normal's existing first-start tip skips it.
    channel.agentMode = "normal";
    channel.requiredMention = false;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(page([message("1002")]))
      .mockResolvedValueOnce(page([]));
    const threads = { fetchActive: vi.fn() };
    mocks.fetchChannel.mockResolvedValue({
      id: "root",
      type: ChannelType.GuildText,
      messages: { fetch },
      threads,
    });
    await backfill([group], repo);
    expect(fetch.mock.calls).toEqual([
      [{ limit: 1, cache: false }],
      [{ after: "1002", limit: 100, cache: false }],
    ]);
    expect(repo.getDiscordCursor("root")).toBe("1002");
    expectNoRunsOrResponses(captured);
    expect(await session.loadMessages(group.name, "root")).toHaveLength(1);

    // A later normal-mode outage still uses the unchanged recovery path.
    fetch.mockResolvedValueOnce(page([message("1003")]));
    await backfill([group], repo);
    expect(repo.findByIdempotencyKey("discord-message:1003")).toMatchObject({
      sessionId: "root",
    });
    expect(repo.getDiscordCursor("root")).toBe("1003");
    expect(threads.fetchActive).not.toHaveBeenCalled();
  });
});
