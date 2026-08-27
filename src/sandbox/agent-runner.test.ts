import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConvertToLlm } from "./agent-runner.js";

const { AgentMock } = vi.hoisted(() => ({
  AgentMock: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: () => ["provider-a", "zai"],
  getModels: (provider: string) =>
    provider === "zai"
      ? [{ id: "glm-4.7-flash", name: "GLM-4.7-Flash" }]
      : [{ id: "model-x", name: "Model X" }],
}));

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn().mockResolvedValue([]),
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    Agent: AgentMock,
  };
});

vi.mock("../agent/session.js", () => ({
  loadMessages: vi.fn(),
  appendMessage: vi.fn(),
  loadOrCreateSessionTimeAnchor: vi.fn().mockResolvedValue(1787868000000),
}));

const { runAgentLoop, waitForNetwork, DEFAULT_SYSTEM_PROMPT } = await import(
  "./agent-runner.js"
);
const { loadMessages, appendMessage, loadOrCreateSessionTimeAnchor } =
  await import("../agent/session.js");
const { readFile, readdir } = await import("node:fs/promises");
let lastAgentOptions: unknown;

function datePromptJST(): string {
  return "## Session time anchor\n\nStarted: 2026-08-28 07:00 JST (Fri)";
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
    vi.mocked(loadOrCreateSessionTimeAnchor).mockResolvedValue(1787868000000);
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
    expect(loadOrCreateSessionTimeAnchor).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.any(Number),
    );
    expect(lastAgentOptions).toMatchObject({
      initialState: {
        systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n${datePromptJST()}`,
        model: { id: "glm-4.7-flash", name: "GLM-4.7-Flash" },
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

  it("request-scoped instructionsをsystem promptだけに追加する", async () => {
    await runAgentLoop(
      "test-group",
      "session-1",
      "こんにちは",
      {},
      undefined,
      "独立行に <NO_REPLY> と出力する",
    );

    expect(lastAgentOptions).toMatchObject({
      initialState: {
        systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n${datePromptJST()}\n\n独立行に <NO_REPLY> と出力する`,
      },
    });
    expect(appendMessage).not.toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        content: expect.stringContaining("<NO_REPLY>"),
      }),
    );
  });

  it("agent.prompt の所要時間とassistant usage合計をイベント出力する", async () => {
    const subscribers: Array<(event: unknown) => void> = [];
    const messages = [
      {
        role: "assistant",
        content: [],
        usage: {
          input: 100,
          output: 10,
          cacheRead: 80,
          cacheWrite: 5,
          totalTokens: 195,
        },
        stopReason: "toolUse",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: {
          input: 120,
          output: 20,
          cacheRead: 90,
          cacheWrite: 0,
          totalTokens: 230,
        },
        stopReason: "stop",
      },
    ];
    AgentMock.mockImplementation(function () {
      return {
        subscribe: vi.fn((cb: (event: unknown) => void) =>
          subscribers.push(cb),
        ),
        prompt: vi.fn(async () => {
          for (const message of messages) {
            for (const cb of subscribers) {
              cb({ type: "message_end", message });
            }
          }
        }),
      };
    });
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });

    await runAgentLoop("test-group", "session-1", "hi", {});

    const timingLine = written.find((line) =>
      line.includes('"type":"agent_timing"'),
    );
    expect(timingLine).toBeDefined();
    if (!timingLine) throw new Error("timingLine not found");
    const event = JSON.parse(
      timingLine.slice("__DISCORD_EVENT__:".length).trimEnd(),
    );
    expect(event).toEqual({
      type: "agent_timing",
      promptMs: expect.any(Number),
      assistantTurns: 2,
      usage: {
        input: 220,
        output: 30,
        cacheRead: 170,
        cacheWrite: 5,
        totalTokens: 425,
      },
      stopReason: "stop",
    });

    stderrSpy.mockRestore();
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

  it("AGENTS.md がある場合は DEFAULT_SYSTEM_PROMPT を置き換えてシステムプロンプトになる", async () => {
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

    expect(readFile).toHaveBeenCalledWith("/workspace/AGENTS.md", "utf-8");
    expect(lastAgentOptions).toEqual(
      expect.objectContaining({
        initialState: expect.objectContaining({
          // AGENTS.md がある場合は DEFAULT_SYSTEM_PROMPT を完全に置き換える
          systemPrompt: `カスタムプロンプト\n\n${datePromptJST()}`,
        }),
      }),
    );
  });

  it("新規セッションでは AGENTS.md は agents-snapshot として、MEMORY.md は memory-bootstrap として保存する", async () => {
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

    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "agents-snapshot",
        content: "カスタムプロンプト",
      }),
    );
    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "memory-bootstrap",
        content: expect.stringContaining("ユーザーは猫が好き"),
      }),
    );

    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages[0]).toMatchObject({
      role: "custom",
      customType: "agents-snapshot",
    });
    expect(messages[1]).toMatchObject({
      role: "custom",
      customType: "memory-bootstrap",
    });
  });

  it("新規セッションでは SELF.md も memory-bootstrap と同様に self-bootstrap として保存する（agents-snapshot・memory-bootstrap に続いて3番目）", async () => {
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/AGENTS.md") {
        return "カスタムプロンプト" as never;
      }
      if (String(filePath) === "/workspace/MEMORY.md") {
        return "ユーザーは猫が好き" as never;
      }
      if (String(filePath) === "/workspace/memory/SELF.md") {
        return "一人称は「僕」" as never;
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

    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "self-bootstrap",
        content: expect.stringContaining("一人称は「僕」"),
      }),
    );
    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "self-bootstrap",
        content: expect.stringContaining("## Persona (SELF.md)"),
      }),
    );

    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages[0]).toMatchObject({ customType: "agents-snapshot" });
    expect(messages[1]).toMatchObject({ customType: "memory-bootstrap" });
    expect(messages[2]).toMatchObject({ customType: "self-bootstrap" });
  });

  it("新規セッションで AGENTS.md はあるが MEMORY.md がない場合は agents-snapshot のみ保存する", async () => {
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

    const promptCalls = vi
      .mocked(appendMessage)
      .mock.calls.filter(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "role" in call[2] &&
          (call[2] as { role: string }).role === "custom",
      );
    expect(promptCalls).toHaveLength(1);
    expect(promptCalls[0][2]).toMatchObject({
      customType: "agents-snapshot",
      content: "カスタムプロンプト",
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

  it("新規セッションで AGENTS.md が空文字の場合でも agents-snapshot を保存し、次回以降は再読み込みしない", async () => {
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/AGENTS.md") {
        return "" as never;
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

    const snapshotCalls = vi
      .mocked(appendMessage)
      .mock.calls.filter(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "customType" in call[2] &&
          (call[2] as { customType: string }).customType === "agents-snapshot",
      );
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0][2]).toMatchObject({
      customType: "agents-snapshot",
      content: "",
    });
  });

  it("既存セッション（agents-snapshot と memory-bootstrap あり）では AGENTS.md / MEMORY.md を読み込まない", async () => {
    const agentsSnapshotMsg = {
      role: "custom",
      customType: "agents-snapshot",
      content: "古いプロンプト",
      timestamp: Date.now() - 2000,
    };
    const memoryBootstrapMsg = {
      role: "custom",
      customType: "memory-bootstrap",
      content: "## Memory (MEMORY.md)\n\n古い記憶",
      timestamp: Date.now() - 1000,
    };
    vi.mocked(loadMessages).mockResolvedValue([
      agentsSnapshotMsg,
      memoryBootstrapMsg,
    ] as never);

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    expect(readFile).not.toHaveBeenCalledWith("/workspace/AGENTS.md", "utf-8");
    expect(readFile).not.toHaveBeenCalledWith("/workspace/MEMORY.md", "utf-8");

    const promptAppends = vi
      .mocked(appendMessage)
      .mock.calls.filter(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "role" in call[2] &&
          (call[2] as { role: string }).role === "custom",
      );
    expect(promptAppends).toHaveLength(0);

    const systemPrompt = (
      lastAgentOptions as { initialState: { systemPrompt: string } }
    ).initialState.systemPrompt;
    expect(systemPrompt).toContain("古いプロンプト");
  });

  it("既存セッションに memory-bootstrap と self-bootstrap が両方あれば MEMORY.md / SELF.md どちらも読み込まない", async () => {
    vi.mocked(loadMessages).mockResolvedValue([
      {
        role: "custom",
        customType: "memory-bootstrap",
        content: "## Memory (MEMORY.md)\n\n古い記憶",
        timestamp: Date.now() - 2000,
      },
      {
        role: "custom",
        customType: "self-bootstrap",
        content: "## Persona (SELF.md)\n\n古い人格",
        timestamp: Date.now() - 1000,
      },
    ] as never);

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    expect(readFile).not.toHaveBeenCalledWith("/workspace/MEMORY.md", "utf-8");
    expect(readFile).not.toHaveBeenCalledWith(
      "/workspace/memory/SELF.md",
      "utf-8",
    );
    const promptAppends = vi
      .mocked(appendMessage)
      .mock.calls.filter(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "role" in call[2] &&
          (call[2] as { role: string }).role === "custom",
      );
    expect(promptAppends).toHaveLength(0);
  });

  it("memory-bootstrap のみ既存で self-bootstrap がない場合、SELF.md だけ移行対象になる（チャンネルごとに独立判定）", async () => {
    vi.mocked(loadMessages).mockResolvedValue([
      {
        role: "custom",
        customType: "memory-bootstrap",
        content: "## Memory (MEMORY.md)\n\n古い記憶",
        timestamp: Date.now() - 1000,
      },
    ] as never);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/memory/SELF.md") {
        return "後から生えた人格" as never;
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

    expect(readFile).not.toHaveBeenCalledWith("/workspace/MEMORY.md", "utf-8");
    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "self-bootstrap",
        content: expect.stringContaining("後から生えた人格"),
      }),
    );
    const memoryAppends = vi
      .mocked(appendMessage)
      .mock.calls.filter(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "customType" in call[2] &&
          (call[2] as { customType: string }).customType === "memory-bootstrap",
      );
    expect(memoryAppends).toHaveLength(0);
  });

  it("memory-bootstrap のみ既存で self-bootstrap を移行するターンでも、LLM へ渡す順序は memory-bootstrap → self-bootstrap になる", async () => {
    vi.mocked(loadMessages).mockResolvedValue([
      {
        role: "custom",
        customType: "memory-bootstrap",
        content: "## Memory (MEMORY.md)\n\n古い記憶",
        timestamp: Date.now() - 1000,
      },
    ] as never);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/memory/SELF.md") {
        return "後から生えた人格" as never;
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

    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages[0]).toMatchObject({ customType: "memory-bootstrap" });
    expect(messages[1]).toMatchObject({ customType: "self-bootstrap" });
  });

  it("既存セッション（スナップショットなし・旧形式）は AGENTS.md をスナップショット化し、MEMORY.md を memory-bootstrap に移行する", async () => {
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
    expect(systemPrompt).not.toContain("旧記憶");
    expect(systemPrompt).not.toContain("## Memory (MEMORY.md)");

    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "agents-snapshot",
        content: "旧形式プロンプト",
      }),
    );
    expect(appendMessage).toHaveBeenCalledWith(
      "test-group",
      "session-1",
      expect.objectContaining({
        role: "custom",
        customType: "memory-bootstrap",
        content: expect.stringContaining("旧記憶"),
      }),
    );

    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages[0]).toMatchObject({ customType: "agents-snapshot" });
    expect(messages[1]).toMatchObject({ customType: "memory-bootstrap" });
    expect(messages).toHaveLength(3);
  });

  it("ロード時に JSONL 末尾にある agents-snapshot / memory-bootstrap を先頭へ並べ替える（移行ターン以降のキャッシュ整合性）", async () => {
    const agentsSnapshotMsg = {
      role: "custom",
      customType: "agents-snapshot",
      content: "保存済みプロンプト",
      timestamp: 1000,
    };
    const memoryBootstrapMsg = {
      role: "custom",
      customType: "memory-bootstrap",
      content: "## Memory (MEMORY.md)\n\n保存済み記憶",
      timestamp: 1001,
    };
    vi.mocked(loadMessages).mockResolvedValue([
      { role: "user", content: "旧user1", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "旧assistant1" }],
        timestamp: 2,
      },
      { role: "user", content: "旧user2", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "旧assistant2" }],
        timestamp: 4,
      },
      agentsSnapshotMsg,
      memoryBootstrapMsg,
      { role: "user", content: "移行ターンのuser", timestamp: 1002 },
      {
        role: "assistant",
        content: [{ type: "text", text: "移行ターンのassistant" }],
        timestamp: 1003,
      },
    ] as never);

    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    await runAgentLoop("test-group", "session-1", "hi", {});

    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages[0]).toMatchObject({ customType: "agents-snapshot" });
    expect(messages[1]).toMatchObject({ customType: "memory-bootstrap" });
    expect(messages[2]).toMatchObject({ role: "user", content: "旧user1" });
    expect(messages[3]).toMatchObject({ role: "assistant" });
    expect(messages[4]).toMatchObject({ role: "user", content: "旧user2" });
    expect(messages[5]).toMatchObject({ role: "assistant" });
    expect(messages[6]).toMatchObject({
      role: "user",
      content: "移行ターンのuser",
    });
    expect(messages[7]).toMatchObject({ role: "assistant" });
    expect(messages).toHaveLength(8);
  });

  it("AGENTS.md も MEMORY.md も存在しない場合は新規メッセージを追加しない（旧形式セッション）", async () => {
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

    const messages = (
      lastAgentOptions as { initialState: { messages: unknown[] } }
    ).initialState.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "前回の質問" });
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

    const bootstrapCall = vi
      .mocked(appendMessage)
      .mock.calls.find(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "customType" in call[2] &&
          (call[2] as { customType: string }).customType === "memory-bootstrap",
      );
    expect(bootstrapCall).toBeDefined();
    const bootstrapContent = (bootstrapCall?.[2] as { content: string })
      .content;
    expect(bootstrapContent).toContain("あ".repeat(2000));
    expect(bootstrapContent).not.toContain("あ".repeat(2001));
    expect(bootstrapContent).toContain("exceeds the limit (2000 characters)");
  });

  it("SELF.md が文字数上限を超える場合は切り詰めて警告を注入する（新規セッションの bootstrap メッセージ）", async () => {
    const longSelf = "い".repeat(3000);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/memory/SELF.md") {
        return longSelf as never;
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

    const bootstrapCall = vi
      .mocked(appendMessage)
      .mock.calls.find(
        (call) =>
          call[2] &&
          typeof call[2] === "object" &&
          "customType" in call[2] &&
          (call[2] as { customType: string }).customType === "self-bootstrap",
      );
    expect(bootstrapCall).toBeDefined();
    const bootstrapContent = (bootstrapCall?.[2] as { content: string })
      .content;
    expect(bootstrapContent).toContain("い".repeat(2000));
    expect(bootstrapContent).not.toContain("い".repeat(2001));
    expect(bootstrapContent).toContain("exceeds the limit (2000 characters)");
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
      customType: "agents-snapshot",
      content: "古いプロンプト",
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

  it('skills: "*" の場合は systemPrompt にスキル一覧を追加する', async () => {
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

    await runAgentLoop("test-group", "session-1", "hi", { skills: "*" });

    const systemPrompt = (
      lastAgentOptions as { initialState: { systemPrompt: string } }
    ).initialState.systemPrompt;
    expect(systemPrompt).not.toContain(DEFAULT_SYSTEM_PROMPT);
    expect(systemPrompt).toContain("カスタムプロンプト");
    expect(systemPrompt).toContain("<available_skills>");
    expect(systemPrompt).toContain("<name>review</name>");
    expect(systemPrompt).toContain("<description>レビュースキル</description>");
  });

  it("skills 未指定の場合は SKILLS 配下があってもスキル一覧を追加しない", async () => {
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
    expect(systemPrompt).not.toContain("<available_skills>");
    expect(systemPrompt).not.toContain("<name>review</name>");
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

  it("./command 形式のメッセージは元の発言と skill-invocation を分けて prompt する", async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: "review", isDirectory: () => true } as unknown as Awaited<
        ReturnType<typeof readdir>
      >[number],
    ]);
    vi.mocked(readFile).mockImplementation(async (filePath) => {
      if (String(filePath) === "/workspace/SKILLS/review/SKILL.md") {
        return "---\nname: review\ndescription: レビュースキル\n---\n本文だよ" as never;
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

    await runAgentLoop(
      "test-group",
      "session-1",
      "./command review 追加指示だよ",
      { skills: ["review"] },
    );

    expect(mockAgent.prompt).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "./command review 追加指示だよ" }],
      }),
      expect.objectContaining({
        role: "custom",
        customType: "skill-invocation",
        content: expect.stringContaining("本文だよ"),
      }),
    ]);
  });

  it("./command で未知のスキルを指定した場合は LLM を呼ばずにエラーを返す", async () => {
    const mockAgent = createMockAgent(["OK"], {
      role: "assistant",
      content: [{ type: "text", text: "OK" }],
    });
    AgentMock.mockImplementation(function (options: unknown) {
      lastAgentOptions = options;
      return mockAgent;
    });

    const result = await runAgentLoop(
      "test-group",
      "session-1",
      "./command unknown",
      {},
    );

    expect(result).toContain("見つかりません");
    expect(mockAgent.prompt).not.toHaveBeenCalled();
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
    vi.mocked(loadOrCreateSessionTimeAnchor).mockResolvedValue(1787868000000);
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
    vi.mocked(loadOrCreateSessionTimeAnchor).mockResolvedValue(1787868000000);
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

describe("defaultConvertToLlm", () => {
  const agentsSnapshotMsg = {
    role: "custom" as const,
    customType: "agents-snapshot" as const,
    content: "## エージェント設定\n\nテスト",
    timestamp: 500,
  };
  const memoryBootstrapMsg = {
    role: "custom" as const,
    customType: "memory-bootstrap" as const,
    content: "## Memory (MEMORY.md)\n\nテスト",
    timestamp: 1000,
  };
  const selfBootstrapMsg = {
    role: "custom" as const,
    customType: "self-bootstrap" as const,
    content: "## Persona (SELF.md)\n\nテスト",
    timestamp: 1500,
  };
  const userMsg = { role: "user" as const, content: "hi", timestamp: 2000 };
  const assistantMsg = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "hello" }],
    timestamp: 3000,
    stopReason: "end_turn" as const,
    model: "test",
    provider: "test",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cost: { input: 0, output: 0, total: 0 },
      totalTokens: 0,
    },
  };

  it("agents-snapshot メッセージは LLM 送信用メッセージから常に除外する", () => {
    const result = defaultConvertToLlm([agentsSnapshotMsg] as never);
    expect(result).toHaveLength(0);
  });

  it("memory-bootstrap メッセージを user ロールに変換する", () => {
    const result = defaultConvertToLlm([memoryBootstrapMsg] as never);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "user",
      content: memoryBootstrapMsg.content,
    });
  });

  it("2件目以降の memory-bootstrap メッセージはスキップする", () => {
    const result = defaultConvertToLlm([
      memoryBootstrapMsg,
      memoryBootstrapMsg,
    ] as never);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("self-bootstrap メッセージを user ロールに変換する", () => {
    const result = defaultConvertToLlm([selfBootstrapMsg] as never);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "user",
      content: selfBootstrapMsg.content,
    });
  });

  it("2件目以降の self-bootstrap メッセージはスキップする", () => {
    const result = defaultConvertToLlm([
      selfBootstrapMsg,
      selfBootstrapMsg,
    ] as never);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });

  it("memory-bootstrap と self-bootstrap は customType ごとに独立して重複排除する（互いを抑制しない）", () => {
    const result = defaultConvertToLlm([
      memoryBootstrapMsg,
      selfBootstrapMsg,
    ] as never);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: "user",
      content: memoryBootstrapMsg.content,
    });
    expect(result[1]).toMatchObject({
      role: "user",
      content: selfBootstrapMsg.content,
    });
  });

  it("agents-snapshot は除外し、memory-bootstrap と通常メッセージはそのまま通す", () => {
    const result = defaultConvertToLlm([
      agentsSnapshotMsg,
      memoryBootstrapMsg,
      userMsg,
      assistantMsg,
    ] as never);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      role: "user",
      content: memoryBootstrapMsg.content,
    });
    expect(result[1]).toMatchObject({ role: "user", content: "hi" });
    expect(result[2]).toMatchObject({ role: "assistant" });
  });

  it("custom メッセージなしでも通常メッセージを返す", () => {
    const result = defaultConvertToLlm([userMsg, assistantMsg] as never);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[1].role).toBe("assistant");
  });

  it("read の総文字数・総行数と次の読み込み位置を LLM に伝える", () => {
    const readResult = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text" as const, text: "line 1\nline 2" }],
      details: {
        path: "notes.txt",
        size: 23,
        characters: 23,
        returnedCharacters: 13,
        startLine: 1,
        endLine: 2,
        returnedLineCount: 2,
        totalLines: 4,
        eof: false,
      },
      isError: false,
      timestamp: 4000,
    };

    const result = defaultConvertToLlm([readResult] as never);
    expect(result[0]).toMatchObject({ role: "toolResult" });
    expect(result[0].content).toEqual([
      { type: "text", text: "line 1\nline 2" },
      {
        type: "text",
        text: expect.stringContaining("ファイル全体: 23 文字、4 行"),
      },
    ]);
    expect(result[0].content[1]).toMatchObject({
      text: expect.stringContaining("続きは 3 行目から"),
    });
  });

  it("外部化された read 結果には完了済みメタデータを追加しない", () => {
    const readResult = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "read",
      content: [
        {
          type: "text" as const,
          text: "ツール出力が大きいため、全文は一時ファイルに保存されました。",
        },
      ],
      details: {
        path: "notes.txt",
        size: 100_001,
        returnedCharacters: 100_001,
        startLine: 1,
        endLine: 10_000,
        returnedLineCount: 10_000,
        totalLines: 10_000,
        eof: true,
        truncated: true,
        fullOutputPath: "/tmp/my-discord-agent-tool-test/output.txt",
      },
      isError: false,
      timestamp: 4000,
    };

    const result = defaultConvertToLlm([readResult] as never);
    expect(result[0].content).toEqual(readResult.content);
    expect(JSON.stringify(result[0])).not.toContain("EOFまで読み込み済み");
    expect(JSON.stringify(result[0])).not.toContain("今回の返却は");
  });

  it("nested externalizedOutput の read 結果にも完了済みメタデータを追加しない", () => {
    const readResult = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text" as const, text: "temporary notice" }],
      details: {
        path: "notes.txt",
        size: 100_001,
        startLine: 1,
        endLine: 10_000,
        returnedLineCount: 10_000,
        totalLines: 10_000,
        eof: true,
        externalizedOutput: { truncated: true },
      },
      isError: false,
      timestamp: 4000,
    };

    const result = defaultConvertToLlm([readResult] as never);
    expect(result[0].content).toEqual(readResult.content);
  });

  it("skill-invocation メッセージを user ロールに変換する", () => {
    const skillInvocationMsg = {
      role: "custom" as const,
      customType: "skill-invocation" as const,
      content: "スキル本文",
      timestamp: 2500,
    };
    const result = defaultConvertToLlm([skillInvocationMsg] as never);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "user",
      content: "スキル本文",
    });
  });

  it("skill-invocation は memory-bootstrap と違い複数件あっても全て user に変換する", () => {
    const skillInvocationMsg = {
      role: "custom" as const,
      customType: "skill-invocation" as const,
      content: "スキル本文",
      timestamp: 2500,
    };
    const result = defaultConvertToLlm([
      skillInvocationMsg,
      skillInvocationMsg,
    ] as never);
    expect(result).toHaveLength(2);
  });

  it("agents-snapshot/memory-bootstrap 以外の role はライブラリ標準の convertToLlm に委譲する", () => {
    const bashExecutionMsg = {
      role: "bashExecution" as const,
      command: "echo hi",
      output: "hi",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 4000,
    };
    const result = defaultConvertToLlm([bashExecutionMsg] as never);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
  });
});
