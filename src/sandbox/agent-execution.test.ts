import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

const { AgentMock } = vi.hoisted(() => ({ AgentMock: vi.fn() }));

vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-agent-core")>()),
  Agent: AgentMock,
}));

const { runAgent } = await import("./agent-execution.js");

const model = { provider: "test", id: "model" } as Model<Api>;

function createAgentMock() {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    abort: vi.fn(),
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
    }),
    prompt: vi.fn(async () => {
      for (const listener of listeners) {
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "child response" }],
          },
        });
      }
    }),
  };
}

describe("runAgent", () => {
  it("constructs an independent Agent and returns its final text", async () => {
    const agent = createAgentMock();
    AgentMock.mockImplementationOnce(function () {
      return agent;
    });
    const messages = [
      { role: "user", content: "must not be inherited" },
    ] as unknown as AgentMessage[];
    const events: string[] = [];

    const result = await runAgent({
      systemPrompt: "system",
      model,
      messages,
      tools: [],
      thinkingLevel: "off",
      prompt: "task",
      convertToLlm: () => [],
      getApiKey: () => undefined,
      sessionId: "child-run",
      onEvent: (event) => events.push(event.type),
    });

    expect(AgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          systemPrompt: "system",
          model,
          messages,
          tools: [],
          thinkingLevel: "off",
        }),
        sessionId: "child-run",
      }),
    );
    expect(agent.prompt).toHaveBeenCalledWith("task");
    expect(result.response).toBe("child response");
    expect(events).toEqual(["message_end"]);
  });

  it("exposes the terminal assistant status without changing execution errors", async () => {
    const agent = createAgentMock();
    AgentMock.mockImplementationOnce(function () {
      return agent;
    });
    agent.prompt.mockImplementationOnce(async () => {
      for (const listener of (agent.subscribe as ReturnType<typeof vi.fn>).mock
        .calls) {
        listener[0]({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "provider failed",
          },
        });
      }
    });

    const result = await runAgent({
      systemPrompt: "system",
      model,
      messages: [],
      tools: [],
      thinkingLevel: "off",
      prompt: "task",
      convertToLlm: () => [],
      getApiKey: () => undefined,
    });

    expect(result).toMatchObject({
      response: "",
      terminalStopReason: "error",
      terminalErrorMessage: "provider failed",
    });
  });

  it("propagates an abort signal to the independent Agent", async () => {
    const agent = createAgentMock();
    AgentMock.mockImplementationOnce(function () {
      return agent;
    });
    const controller = new AbortController();

    const promise = runAgent({
      systemPrompt: "system",
      model,
      messages: [],
      tools: [],
      thinkingLevel: "off",
      prompt: "task",
      convertToLlm: () => [],
      getApiKey: () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    await promise;

    expect(agent.abort).toHaveBeenCalledOnce();
  });
});
