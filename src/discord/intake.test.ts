import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ChannelType, Collection, type Message, MessageType } from "discord.js";
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
  appendMessage: vi.fn(),
  fetchChannel: vi.fn(),
}));

vi.mock("../agent/session.js", () => ({
  appendMessage: mocks.appendMessage,
}));

vi.mock("../config/groups.js", () => ({
  findGroupByChannelId: mocks.findGroup,
}));

vi.mock("../queue/repository.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../queue/repository.js")>();
  return { ...actual, getQueueRepository: mocks.getRepo };
});

vi.mock("./client.js", () => ({
  getDiscordClientForGroup: () => ({ channels: { fetch: mocks.fetchChannel } }),
}));

const { ingestDiscordMessage, handleLiveDiscordMessage: live } = await import(
  "./intake.js"
);
const { backfillDiscordMessages: backfill } = await import("./backfill.js");
const { beginDiscordChannelBackfill, finishDiscordChannelBackfill } =
  await import("./backfill-state.js");
const repositoryModule = await vi.importActual<
  typeof import("../queue/repository.js")
>("../queue/repository.js");

let db: Database.Database;
let repo: InstanceType<typeof repositoryModule.QueueRepository>;
let root: string;
let session: typeof import("../agent/session.js");

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "discord-intake-"));
  vi.stubEnv("SESSIONS_DIR", root);
  session = await vi.importActual("../agent/session.js");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});
afterEach(async () => {
  repo.close();
  await rm(path.join(root, "group"), { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  db = repositoryModule.openRuntimeDb(":memory:");
  repo = new repositoryModule.QueueRepository(db);
  mocks.getRepo.mockReturnValue(repo);
  mocks.appendMessage.mockImplementation(session.appendMessage);
  mocks.findGroup.mockResolvedValue({
    group: { name: "group" },
    channel: { channelId: "root-1", sessionMode: "auto-thread" },
  });
});

function makeMessage(options: {
  id: string;
  channelId?: string;
  isThread?: boolean;
  channel?: { isThread: () => boolean; parentId: string | null } | null;
  parentId?: string | null;
  isBot?: boolean;
  type?: MessageType;
  webhookId?: string | null;
  mentionsBot?: boolean;
  thread?: { id: string } | null;
  fetchedThread?: { id: string } | null;
  startThread?: ReturnType<typeof vi.fn>;
}): Message {
  return {
    id: options.id,
    channelId: options.channelId ?? "root-1",
    author: { id: "user-id", bot: options.isBot ?? false },
    type: options.type ?? MessageType.Default,
    webhookId: options.webhookId ?? null,
    client: { user: { id: "bot-user" } },
    mentions: {
      users: new Map(
        options.mentionsBot ? [["bot-user", { id: "bot-user" }]] : [],
      ),
    },
    channel:
      options.channel === undefined
        ? {
            isThread: () => options.isThread ?? false,
            parentId: options.parentId ?? null,
          }
        : options.channel,
    content: "hello",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    createdTimestamp: Number(options.id),
    attachments: new Map(),
    thread: options.thread ?? null,
    fetch: vi.fn().mockResolvedValue({ thread: options.fetchedThread ?? null }),
    startThread: options.startThread ?? vi.fn(),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Message;
}

describe("ingestDiscordMessage", () => {
  it("channelが解決できないメッセージを無視してカーソル範囲を返す", async () => {
    const result = await ingestDiscordMessage(
      makeMessage({ id: "message-without-channel", channel: null }),
      { source: "backfill", replyOnFailure: false },
    );

    expect(result).toEqual({
      status: "ignored",
      cursorScope: "root-1",
    });
    expect(
      repo.findByIdempotencyKey("discord-message:message-without-channel"),
    ).toBeUndefined();
  });

  it("auto-threadで新規スレッドを作成し、実際の冪等キーでenqueueする", async () => {
    const startThread = vi.fn().mockResolvedValue({ id: "thread-new" });
    const message = makeMessage({
      id: "message-new",
      startThread,
    });

    const result = await ingestDiscordMessage(message, {
      source: "backfill",
      replyOnFailure: false,
    });

    expect(result).toMatchObject({ status: "enqueued", cursorScope: "root-1" });
    expect(startThread).toHaveBeenCalledOnce();
    const job = repo.findByIdempotencyKey("discord-message:message-new");
    expect(job).toMatchObject({
      idempotencyKey: "discord-message:message-new",
      channelId: "thread-new",
      routingChannelId: "root-1",
      sessionId: "thread-new",
    });
    expect(job?.messageId).toBeUndefined();
  });

  it.each([
    "live",
    "backfill",
  ] as const)("always persists source provenance for %s human messages, including auto-thread roots", async (source) => {
    await ingestDiscordMessage(
      makeMessage({
        id: "normal",
        startThread: vi.fn().mockResolvedValue({ id: "thread-normal" }),
      }),
      { source },
    );
    const job = repo.findByIdempotencyKey("discord-message:normal");
    expect(job).toMatchObject({
      source: {
        kind: "discord",
        sourceId: "normal",
        actorId: "user-id",
        messageType: 0,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    });
    expect(job?.messageId).toBeUndefined();
  });

  it("persists identity for Reply but not command-like message types", async () => {
    await ingestDiscordMessage(
      makeMessage({
        id: "100000000000000001",
        type: MessageType.Reply,
        startThread: vi.fn().mockResolvedValue({ id: "thread-reply" }),
      }),
      { source: "live", replyOnFailure: false },
    );
    expect(
      repo.findByIdempotencyKey("discord-message:100000000000000001"),
    ).toMatchObject({
      source: {
        kind: "discord",
        sourceId: "100000000000000001",
        actorId: "user-id",
        messageType: 19,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    });

    await ingestDiscordMessage(
      makeMessage({
        id: "100000000000000002",
        type: MessageType.ChatInputCommand,
        startThread: vi.fn().mockResolvedValue({ id: "thread-command" }),
      }),
      { source: "live", replyOnFailure: false },
    );
    expect(
      repo.findByIdempotencyKey("discord-message:100000000000000002"),
    ).not.toHaveProperty("source");
  });

  it("does not label even allowed live webhook bot messages as human sources", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: {
        channelId: "root-1",
        sessionMode: "shared",
        allowedWebhookIds: ["allowed"],
      },
    });
    await ingestDiscordMessage(
      makeMessage({ id: "webhook", isBot: true, webhookId: "allowed" }),
      { source: "live" },
    );
    const job = repo.findByIdempotencyKey("discord-message:webhook");
    expect(job).toBeDefined();
    expect(job).not.toHaveProperty("source");
    await ingestDiscordMessage(makeMessage({ id: "bot", isBot: true }), {
      source: "live",
    });
    expect(repo.findByIdempotencyKey("discord-message:bot")).toBeUndefined();
  });

  it("auto-threadで既存スレッドを再利用し、startThreadを呼ばない", async () => {
    const startThread = vi.fn();
    const message = makeMessage({
      id: "message-existing",
      thread: { id: "thread-existing" },
      startThread,
    });

    await ingestDiscordMessage(message, {
      source: "backfill",
      replyOnFailure: false,
    });

    expect(startThread).not.toHaveBeenCalled();
    expect(
      repo.findByIdempotencyKey("discord-message:message-existing"),
    ).toMatchObject({
      channelId: "thread-existing",
      sessionId: "thread-existing",
    });
  });

  it("channelのAgentConfig overrideをqueueへ保持する", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: {
        channelId: "root-1",
        sessionMode: "shared",
        model: { provider: "channel-provider", modelId: "channel-model" },
        tools: [],
        approvalRequiredTools: [],
        skills: ["test-skill"],
        mounts: [{ host: "channel", container: "/channel" }],
      },
    });

    await ingestDiscordMessage(
      makeMessage({ id: "message-channel-override" }),
      { source: "backfill", replyOnFailure: false },
    );

    expect(
      repo.findByIdempotencyKey("discord-message:message-channel-override"),
    ).toMatchObject({
      configOverride: {
        model: { provider: "channel-provider", modelId: "channel-model" },
        tools: [],
        approvalRequiredTools: [],
        skills: ["test-skill"],
        mounts: [{ host: "channel", container: "/channel" }],
      },
    });
  });

  it("liveではgroup担当外のDiscord Bot clientを無視する", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group", bot: "secondary" },
      channel: {
        channelId: "root-1",
        sessionMode: "shared",
        requiredMention: true,
      },
    });

    const result = await ingestDiscordMessage(
      makeMessage({ id: "message-wrong-owner", mentionsBot: true }),
      {
        source: "live",
        replyOnFailure: false,
        discordBotId: "personal",
      },
    );

    expect(result).toMatchObject({ status: "ignored", cursorScope: "root-1" });
    expect(
      repo.findByIdempotencyKey("discord-message:message-wrong-owner"),
    ).toBeUndefined();
  });

  it("requiredMention=trueでは親チャンネルの非mentionメッセージを無視する", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: {
        channelId: "root-1",
        sessionMode: "shared",
        requiredMention: true,
      },
    });

    const result = await ingestDiscordMessage(
      makeMessage({ id: "message-no-mention" }),
      { source: "live", replyOnFailure: false },
    );

    expect(result).toMatchObject({ status: "ignored", cursorScope: "root-1" });
    expect(
      repo.findByIdempotencyKey("discord-message:message-no-mention"),
    ).toBeUndefined();
  });

  describe("appendUserOnly", () => {
    let channel: ChannelConfig;
    let group: GroupConfig;
    beforeEach(() => {
      channel = {
        channelId: "root-1",
        sessionMode: "shared",
        appendUserOnly: true,
        requiredMention: true,
        allowedWebhookIds: ["allowed"],
      };
      group = { name: "group", channels: [channel] };
      mocks.findGroup.mockResolvedValue({ group, channel });
    });

    it("appends live humans/replies in order once, with attachments and provenance, without queue or response", async () => {
      const input = makeMessage({ id: "1001" });
      const reply = makeMessage({ id: "1002", type: MessageType.Reply });
      reply.attachments.set("file", {
        name: "note.txt",
        url: "https://cdn.discordapp.com/note.txt",
      } as never);
      const enqueue = vi.spyOn(repo, "enqueue");
      await Promise.all([live(input), live(reply), live(input)]);
      const store = new Database(
        path.join(root, group.name, "sessions.sqlite"),
        { readonly: true },
      );
      expect(
        store
          .prepare(
            "SELECT payload_json, source_json FROM session_entries ORDER BY sequence",
          )
          .all(),
      ).toEqual(
        [input, reply].map((message) => ({
          payload_json: JSON.stringify({
            role: "user",
            content:
              message === input
                ? "hello"
                : "hello\n\n[添付ファイル]\n- note.txt: https://cdn.discordapp.com/note.txt",
            timestamp: message.createdAt.getTime(),
          }),
          source_json: JSON.stringify({
            kind: "discord",
            sourceId: message.id,
            actorId: message.author.id,
            messageType: message.type,
            createdAt: message.createdAt.toISOString(),
          }),
        })),
      );
      store.close();
      expect(enqueue).not.toHaveBeenCalled();
      for (const message of [input, reply]) {
        expect(message.reply).not.toHaveBeenCalled();
        expect(message.startThread).not.toHaveBeenCalled();
        expect(message.fetch).not.toHaveBeenCalled();
      }
    });

    it.each([
      [{ isBot: true }, "live"],
      [{ isBot: true, webhookId: "allowed" }, "live"],
      [{ webhookId: "allowed" }, "live"],
      [{ type: MessageType.ChatInputCommand }, "live"],
      [{ type: MessageType.ThreadCreated }, "live"],
      [{ isThread: true, parentId: "root-1", channelId: "child" }, "live"],
      [{}, "backfill"],
    ] as const)("excludes %j (%s) without saving or responding", async (options, source) => {
      const input = makeMessage({ id: "excluded", ...options });
      const enqueue = vi.spyOn(repo, "enqueue");
      expect(
        (await ingestDiscordMessage(input, { source, replyOnFailure: true }))
          .status,
      ).toBe("ignored");
      expect(enqueue).not.toHaveBeenCalled();
      expect(mocks.appendMessage).not.toHaveBeenCalled();
      expect(input.startThread).not.toHaveBeenCalled();
      expect(input.reply).not.toHaveBeenCalled();
    });

    it("waits for the earlier live append and continues silently after failure", async () => {
      let rejectFirst!: (error: Error) => void;
      mocks.appendMessage.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      );
      const first = makeMessage({ id: "1001" });
      const firstResult = expect(live(first)).rejects.toThrow("disk full");
      const second = live(makeMessage({ id: "1002" }));
      await vi.waitFor(() =>
        expect(mocks.appendMessage).toHaveBeenCalledOnce(),
      );
      rejectFirst(new Error("disk full"));
      await firstResult;
      expect((await second).status).toBe("appended");
      expect(mocks.appendMessage).toHaveBeenCalledTimes(2);
      expect(first.reply).not.toHaveBeenCalled();
    });

    it.each([
      "1000",
      "",
    ])("clears cursor %j, then restores normal tip seeding and intake without replaying the append-only period", async (cursor) => {
      if (cursor) repo.upsertDiscordCursor(channel.channelId, cursor);
      else repo.initializeDiscordCursor(channel.channelId);
      repo.upsertDiscordCursor("other", "900");
      await backfill([group], repo);
      expect(mocks.fetchChannel).not.toHaveBeenCalled();
      await live(makeMessage({ id: "1001" }));
      expect(repo.isDiscordCursorInitialized(channel.channelId)).toBe(false);
      expect(repo.getDiscordCursor(channel.channelId)).toBeUndefined();
      expect(repo.getDiscordCursor("other")).toBe("900");

      // Restart with normal config; 1002 arrived while the bot was stopped.
      channel.appendUserOnly = false;
      channel.requiredMention = false;
      const history = [
        makeMessage({ id: "1001" }),
        makeMessage({ id: "1002" }),
      ];
      const fetch = vi.fn(
        async ({ after }: { after?: string }) =>
          new Collection(
            (after
              ? history.filter((message) => message.id > after)
              : history.slice(-1)
            ).map((message) => [message.id, message]),
          ),
      );
      mocks.fetchChannel.mockResolvedValue({
        id: channel.channelId,
        type: ChannelType.GuildText,
        messages: { fetch },
      });
      await backfill([group], repo);
      expect(fetch).toHaveBeenNthCalledWith(1, { limit: 1, cache: false });
      expect(repo.getDiscordCursor(channel.channelId)).toBe("1002");
      expect(db.prepare("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({
        count: 0,
      });
      history.push(makeMessage({ id: "1003" }));
      await backfill([group], repo);
      await live(makeMessage({ id: "1004" }));
      for (const id of ["1003", "1004"]) {
        expect(
          repo.findByIdempotencyKey(`discord-message:${id}`),
        ).toMatchObject({ sessionId: channel.channelId });
      }
      expect(mocks.appendMessage).toHaveBeenCalledOnce();
    });
  });

  it.each([
    undefined,
    false,
  ])("appendUserOnly=%sならmention付きの通常messageをenqueueする", async (appendUserOnly) => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: {
        channelId: "root-1",
        sessionMode: "shared",
        requiredMention: true,
        appendUserOnly,
      },
    });

    const result = await ingestDiscordMessage(
      makeMessage({ id: "message-mentioned", mentionsBot: true }),
      { source: "live", replyOnFailure: false },
    );

    expect(result).toMatchObject({ status: "enqueued", cursorScope: "root-1" });
    expect(
      repo.findByIdempotencyKey("discord-message:message-mentioned"),
    ).toBeDefined();
    expect(mocks.appendMessage).not.toHaveBeenCalled();
  });

  it("thread messages retain the thread destination while routing by the parent channel", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: { channelId: "root-1", sessionMode: "thread" },
    });
    const result = await ingestDiscordMessage(
      makeMessage({
        id: "thread-message",
        channelId: "thread-1",
        isThread: true,
        parentId: "root-1",
      }),
      { source: "live", replyOnFailure: false },
    );

    expect(result).toMatchObject({
      status: "enqueued",
      cursorScope: "thread-1",
    });
    expect(
      repo.findByIdempotencyKey("discord-message:thread-message"),
    ).toMatchObject({
      channelId: "thread-1",
      routingChannelId: "root-1",
      sessionId: "thread-1",
    });
  });

  it("requiredMentionはthreadでも親チャンネル設定を使う", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: {
        channelId: "root-1",
        sessionMode: "thread",
        requiredMention: true,
      },
    });

    const result = await ingestDiscordMessage(
      makeMessage({
        id: "thread-message-no-mention",
        channelId: "thread-1",
        isThread: true,
        parentId: "root-1",
      }),
      { source: "live", replyOnFailure: false },
    );

    expect(mocks.findGroup).toHaveBeenCalledWith("root-1");
    expect(result).toMatchObject({
      status: "ignored",
      cursorScope: "thread-1",
    });
    expect(
      repo.findByIdempotencyKey("discord-message:thread-message-no-mention"),
    ).toBeUndefined();
  });

  it.each([
    { label: "bot", isBot: true, webhookId: null },
    { label: "Webhook", isBot: true, webhookId: "allowed-webhook" },
  ])("backfillでは$labelメッセージを除外する", async ({ isBot, webhookId }) => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: {
        channelId: "root-1",
        sessionMode: "shared",
        allowedWebhookIds: ["allowed-webhook"],
      },
    });
    const message = makeMessage({
      id: `message-${webhookId ?? "bot"}`,
      isBot,
      webhookId,
    });

    const result = await ingestDiscordMessage(message, {
      source: "backfill",
      replyOnFailure: false,
    });

    expect(result).toMatchObject({ status: "ignored", cursorScope: "root-1" });
    expect(
      repo.findByIdempotencyKey(`discord-message:${message.id}`),
    ).toBeUndefined();
  });

  it("起動時バックフィル中はliveカーソルを更新しない", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: { channelId: "root-1", sessionMode: "shared" },
    });
    beginDiscordChannelBackfill(["root-1"]);
    try {
      await ingestDiscordMessage(makeMessage({ id: "message-live" }), {
        source: "live",
        replyOnFailure: false,
      });

      expect(
        repo.findByIdempotencyKey("discord-message:message-live"),
      ).toBeDefined();
      expect(repo.getDiscordCursor("root-1")).toBeUndefined();
    } finally {
      finishDiscordChannelBackfill("root-1");
    }
  });

  it("enqueue失敗時はliveカーソルを更新しない", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: { channelId: "root-1", sessionMode: "shared" },
    });
    const enqueue = vi.spyOn(repo, "enqueue").mockImplementation(() => {
      throw new Error("disk full");
    });
    const upsertCursor = vi.spyOn(repo, "upsertDiscordCursor");
    const message = makeMessage({ id: "message-failed" });

    await expect(
      ingestDiscordMessage(message, { source: "live", replyOnFailure: false }),
    ).rejects.toThrow("disk full");

    expect(enqueue).toHaveBeenCalledOnce();
    expect(upsertCursor).not.toHaveBeenCalled();
  });
});
