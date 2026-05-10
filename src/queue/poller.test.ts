import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxMessage } from "./inbox.js";

vi.mock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../config/group-config.js", () => ({ loadGroupConfig: vi.fn() }));
vi.mock("../discord/client.js", () => ({
  client: { channels: { fetch: vi.fn() } },
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
      allowedMentions: { repliedUser: false },
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
      allowedMentions: { repliedUser: false },
    });
    expect(mockSend).toHaveBeenNthCalledWith(2, "A");
  });
});
