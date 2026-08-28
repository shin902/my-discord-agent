import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRootDelegationLineage, createSubagentTool } from "./subagent.js";

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
  return createRootDelegationLineage(maxDelegationDepth);
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
    expect(result.details).toMatchObject({
      worker: "ephemeral",
      status: "completed",
      taskPreview: "investigate",
      resultPreview: "child result",
    });
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

    expect(result.details).toMatchObject({
      parentRunId: context.parentRun.id,
      status: "completed",
    });
    expect(result.details).not.toHaveProperty("result");
  });

  it("propagates lineage through a nested delegation", async () => {
    const { context, tool } = makeTool(makeParent(3));
    const first = await tool.execute("tool-call", { task: "first" });

    const childTool = runAgentMock.mock.calls[0][0].tools.find(
      (candidate: AgentTool) => candidate.name === "subagent",
    );
    expect(childTool).toBeDefined();
    if (!childTool) throw new Error("nested subagent tool was not wired");

    const nested = await childTool.execute("nested", { task: "second" });
    expect(nested.details.parentRunId).toBe(first.details.runId);
    expect(nested.details.parentRunId).not.toBe(context.parentRun.id);
    expect(runAgentMock.mock.calls[1][0]).toMatchObject({
      messages: [],
      sessionId: nested.details.runId,
    });
  });

  it("reports lifecycle progress and rejects recursive delegation at the depth limit", async () => {
    const parent = makeParent();
    const { tool } = makeTool(parent);
    const updates: Array<{
      text: string;
      details: Record<string, unknown>;
    }> = [];
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
        updates.push({
          text: update.content[0].type === "text" ? update.content[0].text : "",
          details: update.details as Record<string, unknown>,
        });
      },
    );
    expect(updates.some(({ text }) => text.includes("started"))).toBe(true);

    const childTool = runAgentMock.mock.calls[0][0].tools[1] as AgentTool;
    await expect(
      childTool.execute("nested", { task: "nested" }),
    ).rejects.toThrow("最大深度");
    expect(updates.at(-1)?.details).toMatchObject({ status: "completed" });
  });

  it("shows a safe task preview and emits a terminal failed update", async () => {
    const { tool } = makeTool();
    const updates: Array<{ details: Record<string, unknown> }> = [];
    runAgentMock.mockRejectedValue(new Error("secret provider response"));

    await expect(
      tool.execute(
        "tool-call",
        { task: `@everyone investigate\n${"x".repeat(200)}` },
        undefined,
        (update) => updates.push({ details: update.details }),
      ),
    ).rejects.toThrow("secret provider response");

    expect(updates).toHaveLength(2);
    expect(updates[0].details).toMatchObject({
      worker: "ephemeral",
      status: "running",
    });
    expect(updates[0].details.taskPreview).not.toContain("@everyone");
    expect(String(updates[0].details.taskPreview).length).toBeLessThanOrEqual(
      120,
    );
    expect(updates[1].details).toMatchObject({
      worker: "ephemeral",
      status: "failed",
      taskPreview: updates[0].details.taskPreview,
    });
    expect(JSON.stringify(updates[1])).not.toContain("secret provider");
  });

  it("marks the child failed when execution aborts", async () => {
    const { tool } = makeTool();
    const updates: Array<{ details: Record<string, unknown> }> = [];
    const controller = new AbortController();
    runAgentMock.mockImplementation(async () => {
      controller.abort();
      return { response: "ignored", agent: {} };
    });

    await expect(
      tool.execute(
        "tool-call",
        { task: "abort me" },
        controller.signal,
        (update) =>
          updates.push({ details: update.details as Record<string, unknown> }),
      ),
    ).rejects.toThrow("中断");
    expect(updates.at(-1)?.details).toMatchObject({ status: "failed" });
  });

  it.each([
    ["error", "provider failed", "実行に失敗しました: provider failed"],
    ["aborted", undefined, "中断されました"],
  ] as const)("marks a child with stopReason %s as failed", async (stopReason, terminalErrorMessage, expectedError) => {
    const { tool } = makeTool();
    const updates: Array<{ details: Record<string, unknown> }> = [];
    runAgentMock.mockResolvedValue({
      response: "partial",
      agent: {},
      terminalStopReason: stopReason,
      terminalErrorMessage,
    });

    await expect(
      tool.execute("tool-call", { task: "terminal" }, undefined, (update) =>
        updates.push({ details: update.details as Record<string, unknown> }),
      ),
    ).rejects.toThrow(expectedError);
    expect(updates.at(-1)?.details).toMatchObject({ status: "failed" });
  });

  it("marks an empty final response as failed", async () => {
    const { tool } = makeTool();
    const updates: Array<{ details: Record<string, unknown> }> = [];
    runAgentMock.mockResolvedValue({
      response: "  \n",
      agent: {},
      terminalStopReason: "stop",
    });

    await expect(
      tool.execute("tool-call", { task: "empty" }, undefined, (update) =>
        updates.push({ details: update.details as Record<string, unknown> }),
      ),
    ).rejects.toThrow("空の応答");
    expect(updates.at(-1)?.details).toMatchObject({ status: "failed" });
  });
});
