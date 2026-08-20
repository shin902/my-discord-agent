import { Message, ThreadAutoArchiveDuration } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerHandlers } from "./handler.js";
import { findGroupByChannelId } from "../config/groups.js";
import type { DiscordIntakeDependencies } from "./intake.js";

const mockClient = { once: vi.fn(), on: vi.fn() };
const mockAppendInbox = vi.fn();
const mockFindGroup = vi.fn<typeof findGroupByChannelId>();
const dependencies: DiscordIntakeDependencies = {
  findGroupByChannelId: mockFindGroup,
  getQueueRepository: () => ({
    enqueue: mockAppendInbox,
    upsertDiscordCursor: vi.fn(),
  }),
  isDiscordChannelBackfillPending: () => false,
};

// ハンドラーを一度だけ登録し、以降はコールバックを取り出して直接呼ぶ
// SAFETY: The fixture only exercises the once/on registration boundary.
registerHandlers(mockClient as never, undefined, dependencies);

function getMessageHandler(): (msg: Message) => Promise<void> {
  const call = vi
    .mocked(mockClient.on)
    .mock.calls.find(([event]) => event === "messageCreate");
  if (!call) throw new Error("messageCreate ハンドラーが登録されていません");
  // SAFETY: registerHandlers always registers MessageCreate with this signature.
  return call[1] as (msg: Message) => Promise<void>;
}

function makeMockMessage(opts: {
  isThread: boolean;
  channelId: string;
  parentId?: string | null;
  content?: string;
  isBot?: boolean;
  webhookId?: string | null;
  id?: string;
  startThread?: ReturnType<typeof vi.fn>;
  channelFetch?: ReturnType<typeof vi.fn>;
}): Message {
  // SAFETY: MessageFixture supplies every property consumed by the intake boundary.
  const fixture = {
    author: { bot: opts.isBot ?? false },
    webhookId: opts.webhookId ?? null,
    channelId: opts.channelId,
    id: opts.id ?? "000000000000000000",
    channel: {
      isThread: () => opts.isThread,
      parentId: opts.parentId ?? null,
      fetch:
        opts.channelFetch ??
        vi.fn().mockResolvedValue({
          isThread: () => opts.isThread,
          parentId: opts.parentId ?? null,
        }),
    },
    content: opts.content ?? "hello",
    createdAt: new Date(),
    thread: null,
    attachments: new Map(),
    fetch: vi.fn().mockResolvedValue({ thread: null }),
    reply: vi.fn().mockResolvedValue(undefined),
    startThread: opts.startThread ?? vi.fn(),
  };
  return Object.assign(Object.create(Object.prototype), fixture);
}

describe("registerHandlers - MessageCreate", () => {
  beforeEach(() => {
    mockFindGroup.mockReset();
    mockAppendInbox.mockReset().mockResolvedValue(undefined);
  });

  it("起動時バックフィルが未完了でもライブMessageCreateを処理する", async () => {
    let releaseBackfill!: () => void;
    const backfill = new Promise<void>((resolve) => {
      releaseBackfill = resolve;
    });
    const onReady = vi.fn(() => backfill);
    const startupClient = { once: vi.fn(), on: vi.fn() };
    // SAFETY: The fixture only exercises the once/on registration boundary.
    registerHandlers(startupClient as never, onReady, dependencies);

    const readyCall = startupClient.once.mock.calls[0];
    if (!readyCall) throw new Error("ready handler が登録されていません");
    // SAFETY: registerHandlers always registers ClientReady with this signature.
    const readyHandler = readyCall[1] as (client: {
      user: { tag: string };
    }) => void;
    readyHandler({ user: { tag: "test-bot" } });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());

    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "shared" },
    });
    const messageCall = startupClient.on.mock.calls.find(
      ([event]) => event === "messageCreate",
    );
    if (!messageCall)
      throw new Error("messageCreate ハンドラーが登録されていません");
    // SAFETY: registerHandlers always registers MessageCreate with this signature.
    const messageHandler = messageCall[1] as (
      message: Message,
    ) => Promise<void>;

    const liveMessage = messageHandler(
      makeMockMessage({ isThread: false, channelId: "ch-1" }),
    );
    try {
      await vi.waitFor(() => expect(mockAppendInbox).toHaveBeenCalledOnce());
    } finally {
      releaseBackfill();
      await liveMessage;
    }
  });

  it("bot のメッセージは allowedWebhookIds 未設定の場合無視される", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "shared" },
    });
    const msg = makeMockMessage({
      isBot: true,
      isThread: false,
      channelId: "ch-1",
    });
    await getMessageHandler()(msg);
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it("bot のメッセージは webhookId が allowedWebhookIds に無い場合無視される", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: {
        channelId: "ch-1",
        sessionMode: "shared",
        allowedWebhookIds: ["webhook-allowed"],
      },
    });
    const msg = makeMockMessage({
      isBot: true,
      isThread: false,
      channelId: "ch-1",
      webhookId: "webhook-other",
    });
    await getMessageHandler()(msg);
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it("bot のメッセージは webhookId が allowedWebhookIds に含まれていれば処理される", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: {
        channelId: "ch-1",
        sessionMode: "shared",
        allowedWebhookIds: ["webhook-allowed"],
      },
    });
    const msg = makeMockMessage({
      isBot: true,
      isThread: false,
      channelId: "ch-1",
      webhookId: "webhook-allowed",
      content: "RSS更新",
    });
    await getMessageHandler()(msg);
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ch-1",
        content: "RSS更新",
      }),
    );
  });

  it("グループ設定がないチャンネルは無視される", async () => {
    mockFindGroup.mockResolvedValue(null);
    const msg = makeMockMessage({ isThread: false, channelId: "unknown-ch" });
    await getMessageHandler()(msg);
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it("shared モード: 直接メッセージはチャンネルIDをセッションIDとして積む", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "shared" },
    });
    const msg = makeMockMessage({
      isThread: false,
      channelId: "ch-1",
      content: "テスト",
    });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith("ch-1");
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "ch-1",
        groupName: "default",
        content: "テスト",
        messageId: "000000000000000000",
      }),
    );
  });

  it("添付ファイルがある場合は attachments を含めて積む", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "shared" },
    });
    const msg = makeMockMessage({
      isThread: false,
      channelId: "ch-1",
      content: "画像を見て",
    });
    const attachment = Object.assign(Object.create(Object.prototype), {
      url: "https://cdn.discordapp.com/attachments/x/y/photo.png",
      name: "photo.png",
      contentType: "image/png",
      size: 12345,
    });
    msg.attachments.set("att-1", attachment);
    await getMessageHandler()(msg);
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [
          {
            url: "https://cdn.discordapp.com/attachments/x/y/photo.png",
            name: "photo.png",
            contentType: "image/png",
            size: 12345,
          },
        ],
      }),
    );
  });

  it("添付ファイルがない場合は attachments が undefined", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "shared" },
    });
    const msg = makeMockMessage({
      isThread: false,
      channelId: "ch-1",
      content: "テスト",
    });
    await getMessageHandler()(msg);
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({ attachments: undefined }),
    );
  });

  it("shared モード: スレッドメッセージは親チャンネルIDで検索し無視される", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "shared" },
    });
    const msg = makeMockMessage({
      isThread: true,
      channelId: "thread-1",
      parentId: "ch-1",
    });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith("ch-1"); // スレッドIDではなく parentId で検索
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it("キャッシュ未保持のスレッドは再取得した親チャンネルIDで検索する", async () => {
    const channelFetch = vi.fn().mockResolvedValue({
      isThread: () => true,
      parentId: "ch-1",
    });
    mockFindGroup.mockResolvedValue({
      group: { name: "support", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "thread" },
    });
    const msg = makeMockMessage({
      isThread: true,
      channelId: "thread-1",
      parentId: null,
      channelFetch,
    });

    await getMessageHandler()(msg);

    expect(channelFetch).toHaveBeenCalledOnce();
    expect(mockFindGroup).toHaveBeenCalledWith("ch-1");
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "thread-1",
        sessionId: "thread-1",
        groupName: "support",
      }),
    );
  });

  it("thread モード: 直接メッセージはチャンネルIDで検索し無視される", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "support", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "thread" },
    });
    const msg = makeMockMessage({ isThread: false, channelId: "ch-1" });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith("ch-1");
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it("appendInbox が失敗した場合 reply を送信する", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "default", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "shared" },
    });
    mockAppendInbox.mockRejectedValue(new Error("disk full"));
    const msg = makeMockMessage({ isThread: false, channelId: "ch-1" });
    await getMessageHandler()(msg);
    expect(msg.reply).toHaveBeenCalledWith(
      "メッセージの受信に失敗しました。もう一度送ってください。",
    );
  });

  it("thread モード: スレッドメッセージは親チャンネルIDで検索しスレッドIDをセッションIDとして積む", async () => {
    mockFindGroup.mockResolvedValue({
      group: { name: "support", channels: [] },
      channel: { channelId: "ch-1", sessionMode: "thread" },
    });
    const msg = makeMockMessage({
      isThread: true,
      channelId: "thread-123",
      parentId: "ch-1",
      content: "こんにちは",
    });
    await getMessageHandler()(msg);
    expect(mockFindGroup).toHaveBeenCalledWith("ch-1"); // スレッドIDではなく parentId で検索
    expect(mockAppendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "thread-123",
        groupName: "support",
        messageId: "000000000000000000",
      }),
    );
  });

  describe("auto-thread モード", () => {
    it("親チャンネルのメッセージ: スレッドを作成し、スレッドIDで inbox に積む", async () => {
      const mockThread = { id: "thread-new-abc" };
      const startThread = vi.fn().mockResolvedValue(mockThread);
      mockFindGroup.mockResolvedValue({
        group: { name: "group1", channels: [] },
        channel: { channelId: "ch-auto", sessionMode: "auto-thread" },
      });
      const msg = makeMockMessage({
        isThread: false,
        channelId: "ch-auto",
        id: "111222333a1b2c3",
        content: "質問です",
        startThread,
      });
      await getMessageHandler()(msg);
      expect(startThread).toHaveBeenCalledWith({
        name: "thread-a1b2c3",
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
      expect(mockAppendInbox).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "thread-new-abc",
          sessionId: "thread-new-abc",
          groupName: "group1",
          messageId: undefined,
        }),
      );
    });

    it("親チャンネルのメッセージにURLがある: hostname-suffix でスレッドを作成する", async () => {
      const mockThread = { id: "thread-url-xyz" };
      const startThread = vi.fn().mockResolvedValue(mockThread);
      mockFindGroup.mockResolvedValue({
        group: { name: "group1", channels: [] },
        channel: { channelId: "ch-auto", sessionMode: "auto-thread" },
      });
      const msg = makeMockMessage({
        isThread: false,
        channelId: "ch-auto",
        id: "000000000000a1b2c3",
        content: "https://github.com/example/repo を教えて",
        startThread,
      });
      await getMessageHandler()(msg);
      expect(startThread).toHaveBeenCalledWith({
        name: "github-com-a1b2c3",
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });
    });

    it("startThread が失敗した場合: inbox に積まず reply を送信する", async () => {
      const startThread = vi
        .fn()
        .mockRejectedValue(new Error("Missing Permissions"));
      mockFindGroup.mockResolvedValue({
        group: { name: "group1", channels: [] },
        channel: { channelId: "ch-auto", sessionMode: "auto-thread" },
      });
      const msg = makeMockMessage({
        isThread: false,
        channelId: "ch-auto",
        content: "質問です",
        startThread,
      });
      await getMessageHandler()(msg);
      expect(mockAppendInbox).not.toHaveBeenCalled();
      expect(msg.reply).toHaveBeenCalledWith(
        "スレッドの作成に失敗しました。もう一度送ってください。",
      );
    });

    it("スレッド内のメッセージ: スレッドIDをそのまま channelId/sessionId として積む", async () => {
      mockFindGroup.mockResolvedValue({
        group: { name: "group1", channels: [] },
        channel: { channelId: "ch-auto", sessionMode: "auto-thread" },
      });
      const msg = makeMockMessage({
        isThread: true,
        channelId: "thread-existing-456",
        parentId: "ch-auto",
        content: "続きです",
      });
      await getMessageHandler()(msg);
      expect(mockAppendInbox).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "thread-existing-456",
          sessionId: "thread-existing-456",
          groupName: "group1",
          messageId: "000000000000000000",
        }),
      );
    });

    it("親チャンネル: appendInbox が失敗した場合 reply を送信する", async () => {
      const startThread = vi.fn().mockResolvedValue({ id: "thread-fail-abc" });
      mockFindGroup.mockResolvedValue({
        group: { name: "group1", channels: [] },
        channel: { channelId: "ch-auto", sessionMode: "auto-thread" },
      });
      mockAppendInbox.mockRejectedValue(new Error("disk full"));
      const msg = makeMockMessage({
        isThread: false,
        channelId: "ch-auto",
        content: "質問です",
        startThread,
      });
      await getMessageHandler()(msg);
      expect(msg.reply).toHaveBeenCalledWith(
        "メッセージの受信に失敗しました。もう一度送ってください。",
      );
    });

    it("スレッド内: appendInbox が失敗した場合 reply を送信する", async () => {
      mockFindGroup.mockResolvedValue({
        group: { name: "group1", channels: [] },
        channel: { channelId: "ch-auto", sessionMode: "auto-thread" },
      });
      mockAppendInbox.mockRejectedValue(new Error("disk full"));
      const msg = makeMockMessage({
        isThread: true,
        channelId: "thread-existing-456",
        parentId: "ch-auto",
        content: "続きです",
      });
      await getMessageHandler()(msg);
      expect(msg.reply).toHaveBeenCalledWith(
        "メッセージの受信に失敗しました。もう一度送ってください。",
      );
    });
  });
});
