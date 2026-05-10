import type { Message } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client.js", () => ({
  client: { once: vi.fn(), on: vi.fn() },
}));

vi.mock("../queue/inbox.js", () => ({
  appendInbox: vi.fn(),
}));

vi.mock("../config/groups.js", () => ({
  findGroupByChannelId: vi.fn(),
}));

const { client } = await import("./client.js");
const { appendInbox } = await import("../queue/inbox.js");
const { findGroupByChannelId } = await import("../config/groups.js");
const { registerHandlers } = await import("./handler.js");

const mockAppendInbox = vi.mocked(appendInbox);
const mockFindGroup = vi.mocked(findGroupByChannelId);

// ハンドラーを一度だけ登録し、以降はコールバックを取り出して直接呼ぶ
registerHandlers();

function getMessageHandler(): (msg: Message) => Promise<void> {
  const calls = vi.mocked(client.on).mock.calls as [
    string,
    (msg: Message) => Promise<void>,
  ][];
  const call = calls.find(([event]) => event === "messageCreate");
  if (!call) throw new Error("messageCreate ハンドラーが登録されていません");
  return call[1];
}

function makeMockMessage(opts: {
  isThread: boolean;
  channelId: string;
  parentId?: string | null;
  content?: string;
  isBot?: boolean;
  id?: string;
  startThread?: ReturnType<typeof vi.fn>;
}): Message {
  return {
    author: { bot: opts.isBot ?? false },
    channelId: opts.channelId,
    id: opts.id ?? "000000000000000000",
    channel: {
      isThread: () => opts.isThread,
      parentId: opts.parentId ?? null,
    },
    content: opts.content ?? "hello",
    createdAt: new Date(),
    reply: vi.fn().mockResolvedValue(undefined),
    startThread: opts.startThread ?? vi.fn(),
  } as unknown as Message;
}

describe("registerHandlers - MessageCreate", () => {
  beforeEach(() => {
    mockFindGroup.mockReset();
    mockAppendInbox.mockReset().mockResolvedValue(undefined);
  });

  it("bot のメッセージは無視される", async () => {
    const msg = makeMockMessage({
      isBot: true,
      isThread: false,
      channelId: "ch-1",
    });
    await getMessageHandler()(msg);
    expect(mockFindGroup).not.toHaveBeenCalled();
    expect(mockAppendInbox).not.toHaveBeenCalled();
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
      }),
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
      expect(startThread).toHaveBeenCalledWith({ name: "thread-a1b2c3" });
      expect(mockAppendInbox).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "thread-new-abc",
          sessionId: "thread-new-abc",
          groupName: "group1",
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
      expect(startThread).toHaveBeenCalledWith({ name: "github-com-a1b2c3" });
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
        }),
      );
    });
  });
});
