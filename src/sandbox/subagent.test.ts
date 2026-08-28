import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRunRegistry } from "./agent-run.js";
import { createSubagentTool } from "./subagent.js";

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock("./agent-execution.js", () => ({
  runAgent: runAgentMock,
}));

const model = { provider: "test", id: "test-model" } as Model<Api>;
const baseTool: AgentTool = {
  name: "read",
  label: "Read",
  description: "Read",
  parameters: {} as never,
  execute: vi.fn(),
};

function makeParent(maxDelegationDepth = 1) {
  return agentRunRegistry.create({
    kind: "root",
    maxDelegationDepth,
  });
}

function makeTool(parent = makeParent()) {
  const context = {
    parentRun: parent,
    systemPrompt: "system prompt",
    model,
    tools: [] as AgentTool[],
    thinkingLevel: "off" as const,
    convertToLlm: vi.fn(() => []),
    getApiKey: vi.fn(),
  };
  const tool = createSubagentTool(context);
  context.tools = [baseTool, tool];
  return { context, tool };
}

describe("createSubagentTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgentMock.mockResolvedValue({ response: "child result", agent: {} });
  });

  it("creates an independent child run and copies execution scope without messages", async () => {
    const { context, tool } = makeTool();
    const result = await tool.execute("tool-call", { task: "investigate" });

    expect(result.content).toEqual([{ type: "text", text: "child result" }]);
    const execution = runAgentMock.mock.calls[0][0];
    expect(execution).toMatchObject({
      systemPrompt: context.systemPrompt,
      model,
      messages: [],
      sessionId: result.details.runId,
      prompt: "investigate",
    });
    expect(execution.tools).toHaveLength(2);
    expect(execution.tools[0]).toBe(baseTool);
    expect(execution.tools[1]).not.toBe(tool);

    const child = agentRunRegistry.get(result.details.runId);
    expect(child).toMatchObject({
      parentRunId: context.parentRun.id,
      kind: "subagent",
      status: "completed",
      delegationDepth: 1,
      maxDelegationDepth: 1,
      result: "child result",
    });
    expect(child?.startedAt).toBeLessThanOrEqual(child?.completedAt ?? 0);
  });

  it("forwards child tool progress and rejects recursive delegation at the depth limit", async () => {
    const parent = makeParent();
    const { tool } = makeTool(parent);
    const updates: string[] = [];
    runAgentMock.mockImplementation(async (options) => {
      options.onEvent({
        type: "tool_execution_start",
        toolCallId: "call",
        toolName: "read",
        args: {},
      });
      return { response: "done", agent: {} };
    });

    await tool.execute(
      "tool-call",
      { task: "inspect" },
      undefined,
      (update) => {
        updates.push(
          update.content[0].type === "text" ? update.content[0].text : "",
        );
      },
    );
    expect(updates.some((text) => text.includes("read started"))).toBe(true);

    const childId = runAgentMock.mock.calls[0][0].sessionId as string;
    const childTool = runAgentMock.mock.calls[0][0].tools[1] as AgentTool;
    await expect(
      childTool.execute("nested", { task: "nested" }),
    ).rejects.toThrow("最大深度");
    expect(agentRunRegistry.get(childId)?.status).toBe("completed");
  });

  it("marks the child failed when execution aborts", async () => {
    const { tool } = makeTool();
    const controller = new AbortController();
    runAgentMock.mockImplementation(async () => {
      controller.abort();
      return { response: "ignored", agent: {} };
    });

    await expect(
      tool.execute("tool-call", { task: "abort me" }, controller.signal),
    ).rejects.toThrow("中断");
    const childId = runAgentMock.mock.calls[0][0].sessionId as string;
    expect(agentRunRegistry.get(childId)?.status).toBe("failed");
  });

  it.each([
    ["error", "provider failed", "実行に失敗しました: provider failed"],
    ["aborted", undefined, "中断されました"],
  ] as const)("marks a child with stopReason %s as failed", async (stopReason, terminalErrorMessage, expectedError) => {
    const { tool } = makeTool();
    runAgentMock.mockResolvedValue({
      response: "partial",
      agent: {},
      terminalStopReason: stopReason,
      terminalErrorMessage,
    });

    await expect(
      tool.execute("tool-call", { task: "terminal" }),
    ).rejects.toThrow(expectedError);
    const childId = runAgentMock.mock.calls[0][0].sessionId as string;
    expect(agentRunRegistry.get(childId)?.status).toBe("failed");
  });

  it("marks an empty final response as failed", async () => {
    const { tool } = makeTool();
    runAgentMock.mockResolvedValue({
      response: "  \n",
      agent: {},
      terminalStopReason: "stop",
    });

    await expect(tool.execute("tool-call", { task: "empty" })).rejects.toThrow(
      "空の応答",
    );
    const childId = runAgentMock.mock.calls[0][0].sessionId as string;
    expect(agentRunRegistry.get(childId)?.status).toBe("failed");
  });
});
