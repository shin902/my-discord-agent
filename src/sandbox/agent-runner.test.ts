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

const { runAgentLoop, waitForNetwork } = await import("./agent-runner.js");
const { loadMessages, appendMessage } = await import("../agent/session.js");
const { readFile, readdir } = await import("node:fs/promises");
let lastAgentOptions: unknown;

function todayJST(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}

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

    const today = todayJST();
    expect(loadMessages).toHaveBeenCalledWith("test-group", "session-1");
    expect(lastAgentOptions).toMatchObject({
      initialState: {
        systemPrompt: `あなたは役立つDiscordアシスタントです。\n\n## 今日の日付\n\n${today} (JST)`,
        model: { id: "kimi-k2.6", name: "Kimi K2.6" },
        thinkingLevel: "off",
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

  it("新規セッションでは AGENTS.md の内容を systemPrompt に使用する（AGENTS.md / MEMORY.md のセクションは除外）", async () => {
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/AGENTS.md") {
        return "カスタムプロンプト" as never;
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

    const today = todayJST();
    expect(readFile).toHaveBeenCalledWith("/workspace/AGENTS.md", "utf-8");
    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          // 新方式: AGENTS.md をシステムプロンプトに結合せず、スキル + 日付のみ
          systemPrompt: `カスタムプロンプト\n\n## 今日の日付\n\n${today} (JST)`,
        }),
      }),
    );
  });

  it("新規セッションでは AGENTS.md / MEMORY.md を custom メッセージとして注入する", async () => {
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/AGENTS.md") {
        return "カスタムプロンプト" as never;
      }
      if (String(filePath) === "/workspace/MEMORY.md") {
        return "ユーザーは猫が好き" as never;
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

    // bootstrap メッセージが appendMessage で保存される
    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "bootstrap-context",
        content: expect.stringContaining("カスタムプロンプト"),
      }),
    );
    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "bootstrap-context",
        content: expect.stringContaining("ユーザーは猫が好き"),
      }),
    );

    // messages 配列の先頭に custom メッセージが含まれる
    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages[0]).toMatchObject({
      role: "custom",
      customType: "bootstrap-context",
    });
  });

  it("新規セッションで AGENTS.md も MEMORY.md もない場合は custom メッセージを追加しない", async () => {
    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    // bootstrap custom メッセージは追加されない
    const bootstrapCalls = vi
      .mocked(appendMessage)
      .mock.calls.filter(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "role" in call[2] &&
          call[2].role === "custom",
      );
    expect(bootstrapCalls).toHaveLength(0);

    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages).toHaveLength(0);
  });

  it("既存セッション（bootstrap あり）では AGENTS.md / MEMORY.md を読み込まない", async () => {
    const bootstrapMsg = {
      role: "custom",
      customType: "bootstrap-context",
      content: "## エージェント設定 (AGENTS.md)\n\n古いプロンプト",
      timestamp: Date.now() - 1000,
    };
    vi.mocked(loadMessages).mockResolvedValue([bootstrapMsg as never]);

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    // AGENTS.md / MEMORY.md は読み込まれない
    expect(readFile).not.toHaveBeenCalledWith("/workspace/AGENTS.md", "utf-8");
    expect(readFile).not.toHaveBeenCalledWith("/workspace/MEMORY.md", "utf-8");

    // bootstrap custom メッセージは追加で書き込まれない
    const bootstrapAppends = vi
      .mocked(appendMessage)
      .mock.calls.filter(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "role" in call[2] &&
          (call[2] as { role: string }).role === "custom",
      );
    expect(bootstrapAppends).toHaveLength(0);
  });

  it("既存セッション（bootstrap なし・旧形式）では AGENTS.md / MEMORY.md をシステムプロンプトに含める", async () => {
    const existingHistory = [
      { role: "user" as const, content: "前回の質問", timestamp: Date.now() },
    ];
    vi.mocked(loadMessages).mockResolvedValue(existingHistory as never);

    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/AGENTS.md") {
        return "旧形式プロンプト" as never;
      }
      if (String(filePath) === "/workspace/MEMORY.md") {
        return "旧記憶" as never;
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
    expect(systemPrompt).toContain("旧形式プロンプト");
    expect(systemPrompt).toContain("## 記憶 (MEMORY.md)");
    expect(systemPrompt).toContain("旧記憶");
  });

  it("MEMORY.md が存在しない場合は記憶セクションをシステムプロンプトに追加しない（旧形式セッション）", async () => {
    const existingHistory = [
      { role: "user" as const, content: "前回の質問", timestamp: Date.now() },
    ];
    vi.mocked(loadMessages).mockResolvedValue(existingHistory as never);

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
    expect(systemPrompt).not.toContain("## 記憶 (MEMORY.md)");
  });

  it("MEMORY.md が文字数上限を超える場合は切り詰めて警告を注入する（新規セッションの bootstrap メッセージ）", async () => {
    const longMemory = "あ".repeat(3000);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/MEMORY.md") {
        return longMemory as never;
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

    // bootstrap メッセージの content に切り詰めた MEMORY.md が含まれる
    const bootstrapCall = vi
      .mocked(appendMessage)
      .mock.calls.find(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "role" in call[2] &&
          (call[2] as { role: string }).role === "custom",
      );
    expect(bootstrapCall).toBeDefined();
    const bootstrapContent = (bootstrapCall![2] as { content: string }).content;
    expect(bootstrapContent).toContain("あ".repeat(2000));
    expect(bootstrapContent).not.toContain("あ".repeat(2001));
    expect(bootstrapContent).toContain("上限(2000字)を超えています");
  });

  it("不明なプロバイダはエラーをスロー", async () => {
    await expect(
      runAgentLoop("test-group", "session-1", "hi", {
        model: { provider: "unknown", modelId: "model-x" },
      }),
    ).rejects.toThrow("不明なプロバイダ: unknown");
  });

  it("セッション履歴の error/aborted メッセージは Agent に渡さない", async () => {
    const history = [
      { role: "user" as const, content: "前回の質問", timestamp: Date.now() },
      {
        role: "assistant" as const,
        content: [{ type: "text", text: "" }],
        errorMessage: "Context window exceeded",
        stopReason: "error",
        timestamp: Date.now(),
      },
    ];
    vi.mocked(loadMessages).mockResolvedValue(history as never);

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    const passedMessages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(passedMessages).toHaveLength(1);
    expect(passedMessages[0]).toMatchObject({ role: "user" });
  });

  it("メッセージ履歴を Agent に引き継ぐ", async () => {
    const bootstrapMsg = {
      role: "custom",
      customType: "bootstrap-context",
      content: "## エージェント設定 (AGENTS.md)\n\n古いプロンプト",
      timestamp: Date.now() - 1000,
    };
    const history = [
      bootstrapMsg,
      {
        role: "user" as const,
        content: "前回のメッセージ",
        timestamp: Date.now(),
      },
    ];
    vi.mocked(loadMessages).mockResolvedValue(history as never);

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

  it("非 assistant メッセージ（user・tool-result）は appendMessage される", async () => {
    const userMsg = {
      role: "user" as const,
      content: "hi",
      timestamp: Date.now(),
    };
    const mockAgent = {
      subscribe: vi.fn((cb: (event: unknown) => void) => {
        cb({ type: "message_end", message: userMsg });
      }),
      prompt: vi.fn(async () => {}),
    };
    AgentMock.mockImplementation(function () {
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      userMsg,
    );
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

  it("convertToLlm が Agent に渡される", async () => {
    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    expect(lastAgentOptions).toMatchObject({
      convertToLlm: expect.any(Function),
    });
  });
});

describe("runAgentLoop - errorMessage 付き assistant メッセージ", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadMessages).mockResolvedValue([]);
    vi.mocked(appendMessage).mockResolvedValue(undefined);
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    vi.mocked(readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
  });

  it("appendMessage はデバッグ用に呼ばれる（セッションに保存）", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const errorMsg = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      errorMessage: "Context window exceeded",
    };
    AgentMock.mockImplementation(function () {
      return createMockAgent([], errorMsg);
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      errorMsg,
    );
    stderrSpy.mockRestore();
  });

  it("__DISCORD_EVENT__:error として stderr に書かれる", async () => {
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

    AgentMock.mockImplementation(function () {
      return createMockAgent([], {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        errorMessage: "Context window exceeded",
      });
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    const eventLine = written.find((l) => l.startsWith("__DISCORD_EVENT__:"));
    expect(eventLine).toBeDefined();
    if (!eventLine) throw new Error("eventLine not found");
    const event = JSON.parse(
      eventLine.slice("__DISCORD_EVENT__:".length).trimEnd(),
    );
    expect(event).toEqual({
      type: "error",
      message: "Context window exceeded",
    });

    stderrSpy.mockRestore();
  });
});

describe("runAgentLoop - tool_execution_start イベント", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadMessages).mockResolvedValue([]);
    vi.mocked(appendMessage).mockResolvedValue(undefined);
    vi.mocked(readFile).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    vi.mocked(readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
  });

  function makeToolAgent(toolName: string, args: unknown) {
    const subscribers: Array<(event: unknown) => void> = [];
    return {
      subscribe: vi.fn((cb: (event: unknown) => void) => subscribers.push(cb)),
      prompt: vi.fn(async () => {
        for (const cb of subscribers) {
          cb({
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName,
            args,
          });
        }
        for (const cb of subscribers) {
          cb({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "done" }],
            },
          });
        }
      }),
    };
  }

  it("toolLogArgs: false（デフォルト）のとき args を含まない", async () => {
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

    AgentMock.mockImplementation(function () {
      return makeToolAgent("bash", { command: "echo $OPENCODE_API_KEY" });
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    const eventLine = written.find((l) => l.startsWith("__DISCORD_EVENT__:"));
    if (!eventLine) throw new Error("eventLine not found");
    const event = JSON.parse(
      eventLine.slice("__DISCORD_EVENT__:".length).trimEnd(),
    );
    expect(event).toEqual({ type: "tool_start", toolName: "bash" });
    expect(event.args).toBeUndefined();

    stderrSpy.mockRestore();
  });

  it("toolLogArgs: true のとき args を含む", async () => {
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

    AgentMock.mockImplementation(function () {
      return makeToolAgent("bash", { command: "ls /workspace" });
    });

    await runAgentLoop("test-group", "session-1", "hi", { toolLogArgs: true });

    const eventLine = written.find((l) => l.startsWith("__DISCORD_EVENT__:"));
    if (!eventLine) throw new Error("eventLine not found");
    const event = JSON.parse(
      eventLine.slice("__DISCORD_EVENT__:".length).trimEnd(),
    );
    expect(event).toEqual({
      type: "tool_start",
      toolName: "bash",
      args: { command: "ls /workspace" },
    });

    stderrSpy.mockRestore();
  });
});

describe("waitForNetwork", () => {
  const noSleep = async () => {};

  it("初回の lookup で成功すれば即座に返る", async () => {
    const lookupFn = vi.fn().mockResolvedValue(undefined);
    await waitForNetwork({ lookupFn, sleepFn: noSleep });
    expect(lookupFn).toHaveBeenCalledTimes(1);
  });

  it("失敗が続いても成功すればそこで止まる", async () => {
    const lookupFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockResolvedValueOnce(undefined);
    await waitForNetwork({ lookupFn, sleepFn: noSleep });
    expect(lookupFn).toHaveBeenCalledTimes(3);
  });

  it("タイムアウトまで失敗し続けてもエラーにせず終了する", async () => {
    const lookupFn = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    let now = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const sleepFn = async () => {
      now += 500;
    };

    await expect(
      waitForNetwork({ lookupFn, sleepFn, timeoutMs: 1000, retryMs: 500 }),
    ).resolves.toBeUndefined();
    expect(lookupFn.mock.calls.length).toBeGreaterThan(1);

    dateSpy.mockRestore();
  });
});
