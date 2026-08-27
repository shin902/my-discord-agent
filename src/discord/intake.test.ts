import type Database from "better-sqlite3";
import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGroup: vi.fn(),
  getRepo: vi.fn(),
}));

vi.mock("../config/groups.js", () => ({
  findGroupByChannelId: mocks.findGroup,
}));

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
});

function makeMessage(options: {
  id: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string | null;
  isBot?: boolean;
  webhookId?: string | null;
  thread?: { id: string } | null;
  fetchedThread?: { id: string } | null;
  startThread?: ReturnType<typeof vi.fn>;
}): Message {
  return {
    id: options.id,
    channelId: options.channelId ?? "root-1",
    author: { bot: options.isBot ?? false },
    webhookId: options.webhookId ?? null,
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
      sessionId: "thread-new",
    });
    expect(job?.messageId).toBeUndefined();
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
