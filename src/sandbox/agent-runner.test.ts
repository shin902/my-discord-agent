import { beforeEach, describe, expect, it, vi } from "vitest";

const { AgentMock } = vi.hoisted(() => ({
  AgentMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: () => ["provider-a", "opencode-go"],
  getModels: (provider: string) =>
    provider === "opencode-go"
      ? [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
      : [{ id: "model-x", name: "Model X" }],
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: AgentMock,
}));

vi.mock("../agent/session.js", () => ({
  loadMessages: vi.fn(),
  appendMessage: vi.fn(),
}));

vi.mock("../config/group-config.js", () => ({
  loadGroupConfig: vi.fn(),
  loadGroupSystemPrompt: vi.fn(),
}));

const { runAgentLoop } = await import("./agent-runner.js");
const { loadMessages, appendMessage } = await import("../agent/session.js");
const { loadGroupConfig, loadGroupSystemPrompt } = await import(
  "../config/group-config.js"
);
let lastAgentOptions: unknown;

function createMockAgent(deltas: string[], endMessage: unknown) {
  const subscribers: Array<(event: unknown) => void> = [];
  return {
    subscribe: vi.fn((cb: (event: unknown) => void) => subscribers.push(cb)),
    prompt: vi.fn(async () => {
      for (const delta of deltas) {
        for (const cb of subscribers) {
          cb({
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta },
          });
        }
      }
      for (const cb of subscribers) {
        cb({ type: "message_end", message: endMessage });
      }
    }),
  };
}

describe("runAgentLoop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lastAgentOptions = undefined;
    vi.mocked(loadMessages).mockResolvedValue([]);
    vi.mocked(loadGroupConfig).mockResolvedValue({});
    vi.mocked(loadGroupSystemPrompt).mockResolvedValue(null);
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return createMockAgent(["OK"], {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    });
  });

  it("メッセージを送信して返答テキストを返す", async () => {
    const mockAgent = createMockAgent(["Hello", " world"], {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    const result = await runAgentLoop("test-group", "session-1", "こんにちは");

    expect(loadMessages).toHaveBeenCalledWith("test-group", "session-1");
    expect(loadGroupConfig).toHaveBeenCalledWith("test-group");
    expect(loadGroupSystemPrompt).toHaveBeenCalledWith("test-group");
    expect(lastAgentOptions).toEqual({
      initialState: {
        systemPrompt: "あなたは役立つDiscordアシスタントです。",
        model: { id: "kimi-k2.6", name: "Kimi K2.6" },
        messages: [],
        tools: [],
      },
    });
    expect(mockAgent.prompt).toHaveBeenCalledWith("こんにちは");
    expect(result).toBe("Hello world");
    expect(appendMessage).toHaveBeenCalledWith("test-group", "session-1", {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    });
  });

  it("グループ設定のモデルを使用する", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({
      model: { provider: "provider-a", modelId: "model-x" },
    });

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi");

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: { id: "model-x", name: "Model X" },
        }),
      }),
    );
  });

  it("カスタム systemPrompt を使用する", async () => {
    vi.mocked(loadGroupSystemPrompt).mockResolvedValue("カスタムプロンプト");

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi");

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          systemPrompt: "カスタムプロンプト",
        }),
      }),
    );
  });

  it("不明なプロバイダはエラーをスロー", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({
      model: { provider: "unknown", modelId: "model-x" },
    });

    await expect(runAgentLoop("test-group", "session-1", "hi")).rejects.toThrow(
      "不明なプロバイダ: unknown",
    );
  });

  it("メッセージ履歴を Agent に引き継ぐ", async () => {
    const history = [
      {
        role: "user" as const,
        content: "前回のメッセージ",
        timestamp: Date.now(),
      },
    ];
    vi.mocked(loadMessages).mockResolvedValue(history);

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi");

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          messages: history,
        }),
      }),
    );
  });

  it("sandbox ツールはVM内で除外される（webfetchのみ残る）", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({
      tools: ["webfetch", "sandbox"],
    });

    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return createMockAgent(["OK"], {
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    });

    await runAgentLoop("test-group", "session-1", "hi");

    const tools = (
      lastAgentOptions as { initialState: { tools: { name: string }[] } }
    ).initialState.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("webfetch");
  });

  it("VM内で不明なツール名はエラーをスロー", async () => {
    vi.mocked(loadGroupConfig).mockResolvedValue({
      tools: ["unknown-tool"],
    });

    await expect(runAgentLoop("test-group", "session-1", "hi")).rejects.toThrow(
      "不明なツール名: unknown-tool",
    );
  });
});
