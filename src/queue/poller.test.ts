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
