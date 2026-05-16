import { beforeEach, describe, expect, it, vi } from "vitest";

const { AgentMock } = vi.hoisted(() => ({
  AgentMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: () => ["provider-a", "opencode-go"],
  getModels: (provider: string) =>
    provider === "opencode-go"
      ? [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
      : [{ id: "model-x", name: "Model X" }],
}));

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn().mockResolvedValue([]),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  Agent: AgentMock,
}));

vi.mock("../agent/session.js", () => ({
  loadMessages: vi.fn(),
  appendMessage: vi.fn(),
}));

const { runAgentLoop } = await import("./agent-runner.js");
const { loadMessages, appendMessage } = await import("../agent/session.js");
const { readFile, readdir } = await import("node:fs/promises");
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
    vi.mocked(appendMessage).mockResolvedValue(undefined);
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    vi.mocked(readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
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

    const result = await runAgentLoop(
      "test-group",
      "session-1",
      "こんにちは",
      {},
    );

    expect(loadMessages).toHaveBeenCalledWith("test-group", "session-1");
    expect(lastAgentOptions).toEqual({
      initialState: {
        systemPrompt: "あなたは役立つDiscordアシスタントです。",
        model: { id: "kimi-k2.6", name: "Kimi K2.6" },
        messages: [],
        tools: [],
      },
      getApiKey: expect.any(Function),
    });
    expect(mockAgent.prompt).toHaveBeenCalledWith("こんにちは");
    expect(result).toBe("Hello world");
    expect(appendMessage).toHaveBeenCalledWith("test-group", "session-1", {
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    });
  });

  it("グループ設定のモデルを使用する", async () => {
    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {
      model: { provider: "provider-a", modelId: "model-x" },
    });

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          model: { id: "model-x", name: "Model X" },
        }),
      }),
    );
  });

  it("AGENTS.md が存在する場合はその内容を systemPrompt に使用する", async () => {
    vi.mocked(readFile).mockResolvedValue("カスタムプロンプト" as never);

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    expect(readFile).toHaveBeenCalledWith("/workspace/AGENTS.md", "utf-8");
    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          systemPrompt: "カスタムプロンプト",
        }),
      }),
    );
  });

  it("不明なプロバイダはエラーをスロー", async () => {
    await expect(
      runAgentLoop("test-group", "session-1", "hi", {
        model: { provider: "unknown", modelId: "model-x" },
      }),
    ).rejects.toThrow("不明なプロバイダ: unknown");
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

    await runAgentLoop("test-group", "session-1", "hi", {});

    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          messages: history,
        }),
      }),
    );
  });

  it("VM内で不明なツール名はエラーをスロー", async () => {
    await expect(
      runAgentLoop("test-group", "session-1", "hi", {
        tools: ["unknown-tool"],
      }),
    ).rejects.toThrow("不明なツール名: unknown-tool");
  });

  it("appendMessage が失敗した場合は runAgentLoop も reject する", async () => {
    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });
    vi.mocked(appendMessage).mockRejectedValue(
      new Error("session write error"),
    );

    await expect(
      runAgentLoop("test-group", "session-1", "hi", {}),
    ).rejects.toThrow("session write error");
  });

  it("スキルがある場合は systemPrompt にスキル一覧を追加する", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: "review", isDirectory: () => true } as unknown as Awaited<
        ReturnType<typeof readdir>
      >[number],
    ]);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/AGENTS.md") {
        return "カスタムプロンプト" as never;
      }
      if (String(filePath) === "/workspace/SKILLS/review/SKILL.md") {
        return "---\nname: review\ndescription: レビュースキル\n---\n" as never;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    const systemPrompt = (
      lastAgentOptions as { initialState: { systemPrompt: string } }
    ).initialState.systemPrompt;
    expect(systemPrompt).toContain("カスタムプロンプト");
    expect(systemPrompt).toContain("<available_skills>");
    expect(systemPrompt).toContain("<name>review</name>");
    expect(systemPrompt).toContain("<description>レビュースキル</description>");
  });

  it("skills allowlist でフィルタリングする", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: "allowed", isDirectory: () => true } as unknown as Awaited<
        ReturnType<typeof readdir>
      >[number],
      { name: "blocked", isDirectory: () => true } as unknown as Awaited<
        ReturnType<typeof readdir>
      >[number],
    ]);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath).includes("allowed")) {
        return "---\nname: allowed\ndescription: OK\n---\n" as never;
      }
      if (String(filePath).includes("blocked")) {
        return "---\nname: blocked\ndescription: NG\n---\n" as never;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {
      skills: ["allowed"],
    });

    const systemPrompt = (
      lastAgentOptions as { initialState: { systemPrompt: string } }
    ).initialState.systemPrompt;
    expect(systemPrompt).toContain("<name>allowed</name>");
    expect(systemPrompt).not.toContain("<name>blocked</name>");
  });
});
