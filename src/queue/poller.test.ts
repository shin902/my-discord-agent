import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxMessage } from "./inbox.js";

vi.mock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../config/group-config.js", () => ({ loadGroupConfig: vi.fn() }));
vi.mock("../discord/client.js", () => ({
  client: {
    channels: {
      cache: { get: vi.fn().mockReturnValue(undefined) },
      fetch: vi.fn(),
    },
  },
}));
vi.mock("./dead-letter.js", () => ({ appendDeadLetter: vi.fn() }));
vi.mock("./inbox.js", () => ({ prependInbox: vi.fn(), shiftInbox: vi.fn() }));

const { sendMessage } = await import("../agent/manager.js");
const { loadGroupConfig } = await import("../config/group-config.js");
const { client } = await import("../discord/client.js");
const { appendDeadLetter } = await import("./dead-letter.js");
const { prependInbox } = await import("./inbox.js");
const { processMessage } = await import("./poller.js");

function makeMsg(overrides?: Partial<InboxMessage>): InboxMessage {
  return {
    id: "inbox-1",
    channelId: "ch-1",
    groupName: "default",
    sessionId: "ch-1",
    messageId: "msg-original",
    content: "hello",
    timestamp: "2026-01-01T00:00:00.000Z",
    retries: 0,
    ...overrides,
  };
}

describe("processMessage - autoReply", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.mocked(loadGroupConfig).mockReset();
    vi.mocked(sendMessage).mockResolvedValue("AI response");
    vi.mocked(client.channels.fetch).mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    } as never);
    mockSend.mockClear();
  });

  it("autoReply: true かつ messageId あり → reply 形式で送信", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: true });

    await processMessage(makeMsg({ messageId: "msg-original" }));

    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith({
      content: "AI response",
      reply: { messageReference: "msg-original", failIfNotExists: false },
      allowedMentions: { repliedUser: true },
    });
  });

  it("autoReply: true かつ messageId なし → 通常送信にフォールバック", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: true });

    await processMessage(makeMsg({ messageId: undefined }));

    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith("AI response");
  });

  it("autoReply: false → 通常送信", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: false });

    await processMessage(makeMsg());

    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith("AI response");
  });

  it("複数チャンク: 先頭のみ reply 形式、残りは通常送信", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: true });
    vi.mocked(sendMessage).mockResolvedValue("A".repeat(2001));

    await processMessage(makeMsg());

    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenNthCalledWith(1, {
      content: "A".repeat(2000),
      reply: { messageReference: "msg-original", failIfNotExists: false },
      allowedMentions: { repliedUser: true },
    });
    expect(mockSend).toHaveBeenNthCalledWith(2, "A");
  });
});

describe("processMessage - Discord イベント通知", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: false });
    vi.mocked(client.channels.fetch).mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    } as never);
    mockSend.mockClear();
  });

  it("tool_start イベント（args あり）で 🔧 ツール名 + 引数が送信される", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: true });
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({
          type: "tool_start",
          toolName: "read_file",
          args: { path: "/workspace/foo.ts" },
        });
        return "AI response";
      },
    );

    await processMessage(makeMsg({ messageId: "msg-original" }));

    await vi.waitFor(() => {
      // autoReply が true でもツールコールはリプライしない
      expect(mockSend).toHaveBeenCalledWith(
        expect.stringMatching(/^🔧 `read_file` /),
      );
      const call = mockSend.mock.calls.find((c) =>
        String(c[0]).startsWith("🔧"),
      );
      expect(typeof call?.[0]).toBe("string");
    });
  });

  it("tool_start イベント（args なし）で 🔧 ツール名のみが送信される", async () => {
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({ type: "tool_start", toolName: "bash" });
        return "AI response";
      },
    );

    await processMessage(makeMsg());

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith("🔧 `bash`");
    });
  });

  it("cronJobId が設定されている（to-channel cron）場合、tool_start イベントは送信されない", async () => {
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({ type: "tool_start", toolName: "bash" });
        return "AI response";
      },
    );

    await processMessage(makeMsg({ cronJobId: "daily-report" }));

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledOnce();
    });
    expect(mockSend).not.toHaveBeenCalledWith(expect.stringMatching(/^🔧/));
  });

  it("cronJobId が設定されていても error イベントは送信される", async () => {
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({ type: "error", message: "oops" });
        return "";
      },
    );

    await processMessage(makeMsg({ cronJobId: "daily-report" }));

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith("⚠️ エラー: oops");
    });
  });

  it("error イベントで ⚠️ メッセージが Discord に送信される", async () => {
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({ type: "error", message: "Context window exceeded" });
        return "";
      },
    );

    await processMessage(makeMsg());

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith(
        "⚠️ エラー: Context window exceeded",
      );
    });
  });

  it("autoReply: true のとき error イベントは元メッセージに reply 形式で送信される", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: true });
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({ type: "error", message: "Context window exceeded" });
        return "";
      },
    );

    await processMessage(makeMsg({ messageId: "msg-original" }));

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        content: "⚠️ エラー: Context window exceeded",
        reply: { messageReference: "msg-original", failIfNotExists: false },
        allowedMentions: { repliedUser: true },
      });
    });
  });

  it("autoReply: false のとき error イベントは通常送信される", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({ autoReply: false });
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({ type: "error", message: "oops" });
        return "";
      },
    );

    await processMessage(makeMsg({ messageId: "msg-original" }));

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith("⚠️ エラー: oops");
    });
  });

  it("2000文字を超えるイベントテキストは先頭2000文字に切り詰められる", async () => {
    const longMessage = "x".repeat(2100);
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, onDiscordEvent) => {
        onDiscordEvent?.({ type: "error", message: longMessage });
        return "";
      },
    );

    await processMessage(makeMsg());

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledOnce();
      const sent = mockSend.mock.calls[0][0] as string;
      expect(sent.length).toBeLessThanOrEqual(2000);
      expect(sent.endsWith("…")).toBe(true);
    });
  });
});

describe("processMessage - cron-thread", () => {
  const mockThreadSend = vi.fn().mockResolvedValue(undefined);
  const mockThread = { id: "thread-123", send: mockThreadSend };
  const mockThreadsCreate = vi.fn().mockResolvedValue(mockThread);
  const mockGuildTextChannel = {
    type: ChannelType.GuildText,
    threads: { create: mockThreadsCreate },
  };

  function makeCronThreadMsg(overrides?: Partial<InboxMessage>): InboxMessage {
    return makeMsg({
      cronThread: true,
      cronJobId: "daily-report",
      // 2026-06-04T10:30:00.000Z → JST 2026-06-04 19:30
      timestamp: "2026-06-04T10:30:00.000Z",
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.mocked(client.channels.fetch).mockResolvedValue(
      mockGuildTextChannel as never,
    );
    vi.mocked(sendMessage).mockResolvedValue("AI response");
    mockThreadSend.mockClear();
    mockThreadsCreate.mockClear();
    vi.mocked(appendDeadLetter).mockClear();
    vi.mocked(prependInbox).mockClear();
  });

  it("正常系: スレッドを作成して sendMessage を呼び、応答を thread.send で投稿する", async () => {
    await processMessage(makeCronThreadMsg());

    expect(mockThreadsCreate).toHaveBeenCalledOnce();
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      "default",
      "thread-123",
      "hello",
    );
    expect(mockThreadSend).toHaveBeenCalledWith("AI response");
  });

  it("sendMessage が空文字を返した場合 thread.send を呼ばない", async () => {
    vi.mocked(sendMessage).mockResolvedValue("");

    await processMessage(makeCronThreadMsg());

    expect(mockThreadsCreate).toHaveBeenCalledOnce();
    expect(mockThreadSend).not.toHaveBeenCalled();
  });

  it("スレッド名は cron-{jobId}-{YYYY-MM-DD-HH-MM}（JST）の形式", async () => {
    await processMessage(makeCronThreadMsg());

    expect(mockThreadsCreate).toHaveBeenCalledWith({
      name: "cron-daily-report-2026-06-04-19-30",
    });
  });

  it("ジョブID が長い場合はスレッド名が100文字を超えないよう切り詰める", async () => {
    await processMessage(makeCronThreadMsg({ cronJobId: "a".repeat(100) }));

    const { name } = mockThreadsCreate.mock.calls[0][0] as { name: string };
    expect(name.length).toBeLessThanOrEqual(100);
  });

  it("GuildText/GuildAnnouncement 以外のチャンネルは appendDeadLetter に移動する", async () => {
    vi.mocked(client.channels.fetch).mockResolvedValue({
      type: ChannelType.GuildVoice,
    } as never);

    await processMessage(makeCronThreadMsg());

    expect(vi.mocked(appendDeadLetter)).toHaveBeenCalledOnce();
    expect(mockThreadsCreate).not.toHaveBeenCalled();
  });

  it("チャンネル fetch が null を返した場合 appendDeadLetter に移動する", async () => {
    vi.mocked(client.channels.fetch).mockResolvedValue(null as never);

    await processMessage(makeCronThreadMsg());

    expect(vi.mocked(appendDeadLetter)).toHaveBeenCalledOnce();
  });

  it("NonRetryableError は即 appendDeadLetter に移動する", async () => {
    const { NonRetryableError } = await import("../utils/error.js");
    vi.mocked(sendMessage).mockRejectedValue(
      new NonRetryableError("context window exceeded"),
    );

    await processMessage(makeCronThreadMsg());

    expect(vi.mocked(appendDeadLetter)).toHaveBeenCalledOnce();
    expect(vi.mocked(prependInbox)).not.toHaveBeenCalled();
  });

  it("transient error はリトライカウントを増やして prependInbox に戻す", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("network error"));

    await processMessage(makeCronThreadMsg({ retries: 0 }));

    expect(vi.mocked(prependInbox)).toHaveBeenCalledOnce();
    const retried = vi.mocked(prependInbox).mock.calls[0][0];
    expect(retried.retries).toBe(1);
    // スレッド作成後に失敗したので thread.id を引き継ぎ、次回リトライで再作成しない
    expect(retried.cronThreadId).toBe("thread-123");
    expect(vi.mocked(appendDeadLetter)).not.toHaveBeenCalled();
  });

  it("cronThreadId が設定されている場合はスレッド作成をスキップして既存スレッドに送る", async () => {
    const mockSendableThread = { isSendable: () => true, send: mockThreadSend };
    vi.mocked(client.channels.fetch).mockResolvedValue(
      mockSendableThread as never,
    );

    await processMessage(makeCronThreadMsg({ cronThreadId: "thread-123" }));

    expect(mockThreadsCreate).not.toHaveBeenCalled();
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      "default",
      "thread-123",
      "hello",
    );
    expect(mockThreadSend).toHaveBeenCalledWith("AI response");
  });

  it("transient error でリトライ上限に達したら appendDeadLetter に移動する", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("network error"));

    await processMessage(makeCronThreadMsg({ retries: 9 }));

    expect(vi.mocked(appendDeadLetter)).toHaveBeenCalledOnce();
    expect(vi.mocked(prependInbox)).not.toHaveBeenCalled();
  });

  it("cronThread: true だが cronJobId が未設定の場合 appendDeadLetter に移動し通常フローに落ちない", async () => {
    const getCacheSpy = vi.mocked(client.channels.cache.get);
    getCacheSpy.mockClear();

    await processMessage(makeCronThreadMsg({ cronJobId: undefined }));

    expect(vi.mocked(appendDeadLetter)).toHaveBeenCalledOnce();
    expect(mockThreadsCreate).not.toHaveBeenCalled();
    expect(getCacheSpy).not.toHaveBeenCalled(); // typing loop に入っていない
  });

  it("cron-thread は typing indicator を開始しない", async () => {
    const getCacheSpy = vi.mocked(client.channels.cache.get);
    getCacheSpy.mockClear();

    await processMessage(makeCronThreadMsg());

    expect(getCacheSpy).not.toHaveBeenCalled();
  });
});
