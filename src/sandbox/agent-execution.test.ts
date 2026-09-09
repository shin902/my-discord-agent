import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

const { AgentMock, streamSimpleMock } = vi.hoisted(() => ({
  AgentMock: vi.fn(),
  streamSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: streamSimpleMock,
}));

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
    const getApiKey = vi.fn(() => "test-key");
    const events: string[] = [];

    const result = await runAgent({
      systemPrompt: "system",
      model,
      messages,
      tools: [],
      thinkingLevel: "off",
      prompt: "task",
      convertToLlm: () => [],
      getApiKey,
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
        streamFn: expect.any(Function),
        getApiKey,
        sessionId: "child-run",
      }),
    );
    expect(agent.prompt).toHaveBeenCalledWith("task");
    expect(result.response).toBe("child response");
    expect(events).toEqual(["message_end"]);
  });

  it("forces Codex through SSE while preserving the production stream options", async () => {
    vi.clearAllMocks();
    const agent = createAgentMock();
    AgentMock.mockImplementationOnce(function () {
      return agent;
    });
    const codexModel = {
      provider: "openai-codex",
      id: "gpt-6-astra",
    } as Model<Api>;
    const controller = new AbortController();
    const requestOptions = {
      apiKey: "sandbox-placeholder",
      transport: "websocket" as const,
      headers: { "x-request": "preserve-me" },
      maxTokens: 32,
      signal: controller.signal,
      sessionId: "production-run",
    };

    await runAgent({
      systemPrompt: "system",
      model: codexModel,
      messages: [],
      tools: [],
      thinkingLevel: "off",
      prompt: "task",
      convertToLlm: () => [],
      getApiKey: () => "sandbox-placeholder",
    });

    const streamFn = (
      AgentMock.mock.calls[0]?.[0] as {
        streamFn: (
          model: Model<Api>,
          context: Context,
          options: typeof requestOptions,
        ) => unknown;
      }
    ).streamFn;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as Context;
    streamFn(codexModel, context, requestOptions);

    expect(streamSimpleMock).toHaveBeenCalledWith(codexModel, context, {
      ...requestOptions,
      transport: "sse",
    });
  });

  it("passes non-Codex providers' stream options through unchanged", async () => {
    vi.clearAllMocks();
    const agent = createAgentMock();
    AgentMock.mockImplementationOnce(function () {
      return agent;
    });
    const requestOptions = {
      apiKey: "provider-key",
      transport: "websocket" as const,
      headers: { "x-request": "preserve-me" },
    };

    await runAgent({
      systemPrompt: "system",
      model,
      messages: [],
      tools: [],
      thinkingLevel: "off",
      prompt: "task",
      convertToLlm: () => [],
      getApiKey: () => "provider-key",
    });

    const streamFn = (
      AgentMock.mock.calls[0]?.[0] as {
        streamFn: (
          model: Model<Api>,
          context: Context,
          options: typeof requestOptions,
        ) => unknown;
      }
    ).streamFn;
    const context = {
      systemPrompt: "system",
      messages: [],
      tools: [],
    } as Context;
    streamFn(model, context, requestOptions);

    expect(streamSimpleMock).toHaveBeenCalledWith(
      model,
      context,
      requestOptions,
    );
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
