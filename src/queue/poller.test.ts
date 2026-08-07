import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageOptions } from "../agent/manager.js";
import type { InboxMessage } from "./inbox.js";

vi.mock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../config/default-model.js", () => ({
  resolveModelConfig: vi.fn().mockImplementation(async (model) => ({
    provider: model?.provider ?? "zai",
    modelId: model?.modelId ?? "glm-4.7-flash",
  })),
}));
vi.mock("../config/groups.js", () => ({ findGroupByName: vi.fn() }));
vi.mock("../config/providers.js", () => ({
  resolveProviderConcurrency: vi.fn().mockResolvedValue("serial"),
}));
vi.mock("../discord/client.js", () => ({
  client: {
    channels: {
      cache: { get: vi.fn().mockReturnValue(undefined) },
      fetch: vi.fn(),
    },
  },
}));
vi.mock("./dead-letter.js", () => ({ appendDeadLetter: vi.fn() }));
vi.mock("./inbox.js", () => ({
  peekAllUnclaimedInbox: vi.fn(),
  commitInboxResult: vi.fn(),
  failInboxAttempt: vi.fn(),
  freezeInboxExecutionIdentity: vi.fn(),
  markInboxRunning: vi.fn(),
  removeInboxById: vi.fn(),
  updateInboxById: vi.fn(),
  deadLetterInbox: vi.fn(),
}));

const { sendMessage } = await import("../agent/manager.js");
const { findGroupByName } = await import("../config/groups.js");
const { resolveProviderConcurrency } = await import("../config/providers.js");
const { client } = await import("../discord/client.js");
const { removeInboxById, commitInboxResult } = await import("./inbox.js");
const { processMessage } = await import("./poller.js");

beforeEach(() => {
  vi.mocked(sendMessage).mockClear();
  vi.mocked(resolveProviderConcurrency).mockResolvedValue("serial");
});

function makeMsg(overrides?: Partial<InboxMessage>): InboxMessage {
  const now = new Date().toISOString();
  return {
    id: "inbox-1",
    channelId: "ch-1",
    groupName: "default",
    sessionId: "ch-1",
    messageId: "msg-original",
    content: "hello",
    timestamp: now,
    enqueuedAt: now,
    retries: 0,
    ...overrides,
  };
}

describe("processMessage - autoReply", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.mocked(findGroupByName).mockReset();
    vi.mocked(sendMessage).mockResolvedValue("AI response");
    vi.mocked(client.channels.fetch).mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    } as never);
    vi.mocked(removeInboxById).mockClear();
    mockSend.mockClear();
  });

  it("autoReply metadata is handled without a final Discord send", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: true,
    });

    await processMessage(makeMsg({ messageId: "msg-original" }));

    expect(mockSend).not.toHaveBeenCalled();
    expect(removeInboxById).toHaveBeenCalledOnce();
  });

  it("missing messageId does not trigger a final Discord send", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: true,
    });

    await processMessage(makeMsg({ messageId: undefined }));

    expect(mockSend).not.toHaveBeenCalled();
    expect(removeInboxById).toHaveBeenCalledOnce();
  });

  it("autoReply false does not trigger a final Discord send", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    expect(removeInboxById).toHaveBeenCalledOnce();
  });

  it("attachments と configOverride を sendMessage に渡す", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });
    const attachments = [
      {
        url: "https://cdn.discordapp.com/attachments/x/y/photo.png",
        name: "photo.png",
        contentType: "image/png",
        size: 12345,
      },
    ];
    const configOverride = { tools: ["read"], skills: ["session-logs"] };

    await processMessage(makeMsg({ attachments, configOverride }));

    expect(sendMessage).toHaveBeenCalledWith(
      "default",
      "ch-1",
      "hello",
      expect.objectContaining({
        onDiscordEvent: expect.any(Function),
        attachments,
        onExecutionTiming: expect.any(Function),
        configOverride,
      }),
    );
  });

  it("応答時間を区間別の構造化ログに記録する", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onExecutionTiming?.({
          termination: "close",
          exitCode: 0,
          preparationMs: 5,
          dockerRunMs: 35,
          imagePullMs: 10,
          containerAndAgentMs: 25,
          promptMs: 20,
          postPromptMs: 1,
          assistantTurns: 1,
          usage: {
            input: 100,
            output: 20,
            cacheRead: 80,
            cacheWrite: 0,
            totalTokens: 120,
          },
          stopReason: "stop",
        });
        return "AI response";
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processMessage(makeMsg());

    const line = logSpy.mock.calls
      .flat()
      .find((value) => String(value).includes('"event":"response_timing"'));
    expect(line).toBeDefined();
    const details = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(details).toMatchObject({
      event: "response_timing",
      outcome: "success",
      preparationMs: 5,
      agentTermination: "close",
      agentExitCode: 0,
      dockerRunMs: 35,
      imagePullMs: 10,
      containerAndAgentMs: 25,
      containerStartupMs: 4,
      promptMs: 20,
      postPromptMs: 1,
      assistantTurns: 1,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 80,
        cacheWrite: 0,
        totalTokens: 120,
      },
      stopReason: "stop",
    });
    expect(details.queueWaitMs).toEqual(expect.any(Number));
    expect(details.llmLockWaitMs).toEqual(expect.any(Number));

    logSpy.mockRestore();
  });

  it("空応答は success ではなく empty-response として記録する", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });
    vi.mocked(sendMessage).mockResolvedValue("");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    const line = logSpy.mock.calls
      .flat()
      .find((value) => String(value).includes('"event":"response_timing"'));
    const details = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(details.outcome).toBe("empty-response");
    logSpy.mockRestore();
  });

  it("送信不能チャンネルでも agent 結果は Discord 送信なしで完了する", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });
    vi.mocked(client.channels.fetch).mockResolvedValue({
      isSendable: () => false,
      isTextBased: () => false,
    } as never);

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    expect(removeInboxById).toHaveBeenCalledOnce();
  });

  it("複数チャンクも agent 結果として一度だけ確定する", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: true,
    });
    vi.mocked(sendMessage).mockResolvedValue("A".repeat(2001));

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    expect(removeInboxById).toHaveBeenCalledOnce();
  });
});

describe("processMessage - Discord イベント通知", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });
    vi.mocked(client.channels.fetch).mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    } as never);
    mockSend.mockClear();
  });

  it("tool_start イベント（args あり）で 🔧 ツール名 + 引数が送信される", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: true,
    });
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
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
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
          type: "tool_start",
          toolName: "bash",
        });
        return "AI response";
      },
    );

    await processMessage(makeMsg());

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith("🔧 `bash`");
    });
  });

  it("cronJobId が設定されている（direct cron）場合、tool_start イベントは送信されない", async () => {
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
          type: "tool_start",
          toolName: "bash",
        });
        return "AI response";
      },
    );

    await processMessage(makeMsg({ cronJobId: "daily-report" }));

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("cronJobId が設定されていても error イベントは送信される", async () => {
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
          type: "error",
          message: "oops",
        });
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
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
          type: "error",
          message: "Context window exceeded",
        });
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
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: true,
    });
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
          type: "error",
          message: "Context window exceeded",
        });
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
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });
    vi.mocked(sendMessage).mockImplementation(
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
          type: "error",
          message: "oops",
        });
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
      async (_g, _s, _c, options: unknown) => {
        (options as SendMessageOptions | undefined)?.onDiscordEvent?.({
          type: "error",
          message: longMessage,
        });
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
describe("processMessage - durable result", () => {
  beforeEach(() => {
    vi.mocked(sendMessage).mockReset();
    vi.mocked(sendMessage).mockResolvedValue("AI response");
    vi.mocked(commitInboxResult).mockClear();
    vi.mocked(removeInboxById).mockClear();
    vi.mocked(client.channels.fetch).mockClear();
  });

  it("commits the agent result and queues delivery metadata without Discord sends", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "default",
      channels: [],
      autoReply: true,
    });
    const msg = makeMsg({ fencingToken: 4, messageId: "msg-original" });

    await processMessage(msg);

    expect(commitInboxResult).toHaveBeenCalledWith(
      msg.id,
      4,
      "AI response",
      expect.objectContaining({
        empty: false,
        deliveryPayload: {
          destinationType: "channel",
          destinationId: "ch-1",
          replyMessageId: "msg-original",
        },
      }),
    );
  });
  it("keeps typing progress independent from final result delivery", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    vi.mocked(client.channels.cache.get).mockReturnValue({
      isTextBased: () => true,
      sendTyping,
    } as never);
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "default",
      channels: [],
    });
    const msg = makeMsg();

    await processMessage(msg);

    expect(sendTyping).toHaveBeenCalled();
    expect(removeInboxById).toHaveBeenCalledOnce();
    expect(commitInboxResult).not.toHaveBeenCalled();
  });

  it("does not create a delivery for an empty agent result", async () => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "default",
      channels: [],
    });
    vi.mocked(sendMessage).mockResolvedValue("");
    const msg = makeMsg({ fencingToken: 4 });

    await processMessage(msg);

    expect(commitInboxResult).toHaveBeenCalledWith(
      msg.id,
      4,
      "",
      expect.objectContaining({ empty: true }),
    );
  });
});

describe("processMessage - provider ごとの LLM ロック", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.mocked(findGroupByName).mockResolvedValue({
      name: "g",
      channels: [],
      autoReply: false,
    });
    vi.mocked(client.channels.fetch).mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    } as never);
    mockSend.mockClear();
  });

  it("同じデフォルト serial provider は sendMessage の実行が重複しない", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((r) => {
      resolveFirst = r;
    });

    vi.mocked(sendMessage).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = inFlight === 1 ? await first : "second";
      inFlight--;
      return result;
    });

    const p1 = processMessage(makeMsg({ sessionId: "s1" }));
    const p2 = processMessage(makeMsg({ sessionId: "s2" }));

    await new Promise((r) => setTimeout(r, 20));
    // 1つ目が解決するまで2つ目の sendMessage は開始されない
    expect(maxInFlight).toBe(1);

    resolveFirst("first");
    await Promise.all([p1, p2]);
    expect(maxInFlight).toBe(1);
  });

  it("parallel provider は同じ provider でも並列に sendMessage を実行する", async () => {
    vi.mocked(resolveProviderConcurrency).mockResolvedValue("parallel");
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseBoth!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    vi.mocked(sendMessage).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await blocker;
      inFlight--;
      return "response";
    });

    const model = { provider: "codex-oauth", modelId: "gpt-5.2-codex" };
    const p1 = processMessage(
      makeMsg({ id: "first", sessionId: "s1", configOverride: { model } }),
    );
    const p2 = processMessage(
      makeMsg({ id: "second", sessionId: "s2", configOverride: { model } }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxInFlight).toBe(2);

    releaseBoth();
    await Promise.all([p1, p2]);
  });

  it("異なる serial provider は並列に sendMessage を実行する", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseBoth!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    vi.mocked(sendMessage).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await blocker;
      inFlight--;
      return "response";
    });

    const p1 = processMessage(
      makeMsg({
        id: "provider-a-message",
        sessionId: "s1",
        configOverride: {
          model: { provider: "provider-a", modelId: "model-a" },
        },
      }),
    );
    const p2 = processMessage(
      makeMsg({
        id: "provider-b-message",
        sessionId: "s2",
        configOverride: {
          model: { provider: "provider-b", modelId: "model-b" },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxInFlight).toBe(2);

    releaseBoth();
    await Promise.all([p1, p2]);
  });

  it("同じ serial provider は異なる session でも直列化する", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let invocation = 0;
    vi.mocked(sendMessage).mockImplementation(async () => {
      invocation++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (invocation === 1) await first;
      inFlight--;
      return "response";
    });

    const model = { provider: "provider-a", modelId: "model-a" };
    const p1 = processMessage(
      makeMsg({ id: "first", sessionId: "s1", configOverride: { model } }),
    );
    const p2 = processMessage(
      makeMsg({ id: "second", sessionId: "s2", configOverride: { model } }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxInFlight).toBe(1);

    resolveFirst();
    await Promise.all([p1, p2]);
    expect(maxInFlight).toBe(1);
  });
});
