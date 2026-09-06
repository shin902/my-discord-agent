import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { AgentMock } = vi.hoisted(() => ({
  AgentMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-agent-core")>();
  return {
    ...actual,
    Agent: AgentMock,
  };
});

const { runTextOnlyAgent } = await import("./textOnlyAgent.js");

function createMockAgent(endMessage: unknown) {
  const subscribers: Array<(event: unknown) => void> = [];
  return {
    subscribe: vi.fn((cb: (event: unknown) => void) => subscribers.push(cb)),
    prompt: vi.fn(async () => {
      for (const cb of subscribers) {
        cb({ type: "message_end", message: endMessage });
      }
    }),
  };
}

describe("runTextOnlyAgent", () => {
  let lastAgentOptions: { initialState: { tools: unknown[] } } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    lastAgentOptions = undefined;
    AgentMock.mockImplementation(function (options: typeof lastAgentOptions) {
      lastAgentOptions = options;
      return createMockAgent({
        role: "assistant",
        content: [{ type: "text", text: "OK" }],
      });
    });
  });

  // このテストが守る不変条件: runTextOnlyAgent はホストプロセス上で動くため、
  // 実装が将来書き換えられても Agent には常に空の tools しか渡してはならない
  // （ツール付きAgentの生成は src/sandbox/agent-runner.ts に限定する設計）。
  // biome の noRestrictedImports はこのファイル自体の内部実装までは検査できないため、
  // ここでランタイムの不変条件として固定する。
  it("Agentにtoolsを一切渡さない", async () => {
    await runTextOnlyAgent({
      systemPrompt: "system",
      model: {} as Model<Api>,
      prompt: "hello",
      getApiKey: () => Promise.resolve("proxy"),
    });

    expect(lastAgentOptions?.initialState.tools).toEqual([]);
  });
});
