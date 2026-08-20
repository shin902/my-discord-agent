import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  runTextOnlyAgent,
  type TextOnlyAgentFactory,
} from "./textOnlyAgent.js";

type AgentOptions = Parameters<TextOnlyAgentFactory>[0];

function createFakeAgent(endMessage: AgentMessage) {
  const subscribers: Array<(event: AgentEvent) => void> = [];
  return {
    subscribe(callback: (event: AgentEvent) => void): () => void {
      subscribers.push(callback);
      return () => undefined;
    },
    async prompt(): Promise<void> {
      for (const callback of subscribers)
        callback({ type: "message_end", message: endMessage });
    },
  };
}

describe("runTextOnlyAgent", () => {
  const assistantMessage: AgentMessage = {
    role: "assistant",
    content: [{ type: "text", text: "OK" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
  const factory: TextOnlyAgentFactory = (_options: AgentOptions) =>
    createFakeAgent(assistantMessage);
  const options = {
    systemPrompt: "system",
    model: {
      id: "test",
      name: "test",
      api: "openai-chat",
      provider: "test",
      baseUrl: "https://example.test",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4_096,
    } satisfies Model<Api>,
    prompt: "hello",
    getApiKey: () => Promise.resolve("proxy"),
    agentFactory: factory,
  };

  it("Agentにtoolsを一切渡さない", async () => {
    await runTextOnlyAgent(options);
  });

  it("assistantのテキストを返す", async () => {
    const { text } = await runTextOnlyAgent(options);
    expect(text).toBe("OK");
  });
});
