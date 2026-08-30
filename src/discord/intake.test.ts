import type Database from "better-sqlite3";
import { type Message, MessageType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGroup: vi.fn(),
  getRepo: vi.fn(),
  loadMemoryConfig: vi.fn(),
}));

vi.mock("../config/groups.js", () => ({
  findGroupByChannelId: mocks.findGroup,
}));

vi.mock("../config/agent-memory.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/agent-memory.js")>();
  return { ...actual, loadAgentMemoryConfig: mocks.loadMemoryConfig };
});

vi.mock("../queue/repository.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../queue/repository.js")>();
  return { ...actual, getQueueRepository: mocks.getRepo };
});

const { ingestDiscordMessage } = await import("./intake.js");
const { beginDiscordChannelBackfill, finishDiscordChannelBackfill } =
  await import("./backfill-state.js");
const repositoryModule = await vi.importActual<
  typeof import("../queue/repository.js")
>("../queue/repository.js");

let db: Database.Database;
let repo: InstanceType<typeof repositoryModule.QueueRepository>;

afterEach(() => {
  repo?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  db = repositoryModule.openRuntimeDb(":memory:");
  repo = new repositoryModule.QueueRepository(db);
  mocks.getRepo.mockReturnValue(repo);
  mocks.findGroup.mockResolvedValue({
    group: { name: "group" },
    channel: { channelId: "root-1", sessionMode: "auto-thread" },
  });
  mocks.loadMemoryConfig.mockResolvedValue({
    enabled: false,
    baseUrl: "http://127.0.0.1:8420",
    serviceId: "default",
    teamId: "team",
    agentId: "agent",
    eligibleGroups: [],
    timeoutMs: 1000,
  });
});

function makeMessage(options: {
  id: string;
  channelId?: string;
  isThread?: boolean;
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
    channel: {
      isThread: () => options.isThread ?? false,
      parentId: options.parentId ?? null,
    },
    content: "hello",
    createdAt: new Date("2026-08-11T00:00:00.000Z"),
    attachments: new Map(),
    thread: options.thread ?? null,
    fetch: vi.fn().mockResolvedValue({ thread: options.fetchedThread ?? null }),
    startThread: options.startThread ?? vi.fn(),
    reply: vi.fn().mockResolvedValue(undefined),
  } as unknown as Message;
}

describe("ingestDiscordMessage", () => {
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

  it("persists memory identity only for an explicitly eligible normal user turn", async () => {
    mocks.loadMemoryConfig.mockResolvedValue({
      enabled: true,
      baseUrl: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "team",
      agentId: "agent",
      eligibleGroups: ["group"],
      timeoutMs: 1000,
    });
    await ingestDiscordMessage(
      makeMessage({
        id: "eligible",
        startThread: vi.fn().mockResolvedValue({ id: "thread-eligible" }),
      }),
      {
        source: "backfill",
        replyOnFailure: false,
      },
    );
    const eligible = repo.findByIdempotencyKey("discord-message:eligible");
    expect(eligible).toMatchObject({ userId: "user-id" });
    expect(eligible).not.toHaveProperty("authorIsBot");

    mocks.loadMemoryConfig.mockResolvedValue({
      enabled: true,
      baseUrl: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "team",
      agentId: "agent",
      eligibleGroups: [],
      timeoutMs: 1000,
    });
    await ingestDiscordMessage(
      makeMessage({
        id: "ineligible",
        startThread: vi.fn().mockResolvedValue({ id: "thread-ineligible" }),
      }),
      {
        source: "live",
        replyOnFailure: false,
      },
    );
    const ineligible = repo.findByIdempotencyKey("discord-message:ineligible");
    expect(ineligible).not.toHaveProperty("userId");
    expect(ineligible).not.toHaveProperty("authorIsBot");
  });

  it("persists identity for Reply but not command-like message types", async () => {
    mocks.loadMemoryConfig.mockResolvedValue({
      enabled: true,
      baseUrl: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "team",
      agentId: "agent",
      eligibleGroups: ["group"],
      timeoutMs: 1000,
    });

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
      userId: "user-id",
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
    ).not.toHaveProperty("userId");
  });

  it("does not block intake when Agent Memory eligibility loading fails", async () => {
    mocks.loadMemoryConfig.mockRejectedValue(new Error("config unavailable"));
    await ingestDiscordMessage(
      makeMessage({
        id: "memory-config-failed",
        startThread: vi
          .fn()
          .mockResolvedValue({ id: "thread-memory-config-failed" }),
      }),
      {
        source: "live",
        replyOnFailure: false,
      },
    );
    expect(
      repo.findByIdempotencyKey("discord-message:memory-config-failed"),
    ).toBeDefined();
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
        skills: "*",
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
        skills: "*",
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

  it("requiredMention=trueでもBot mentionがあれば親チャンネルでenqueueする", async () => {
    mocks.findGroup.mockResolvedValue({
      group: { name: "group" },
      channel: {
        channelId: "root-1",
        sessionMode: "shared",
        requiredMention: true,
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
