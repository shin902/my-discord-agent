import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { type AgentExecutionOptions, runAgent } from "./agent-execution.js";
import { resultPreview, taskPreview } from "./subagent-preview.js";

export type SubagentStatus = "running" | "completed" | "failed";

/** Minimal immutable lineage passed between recursive delegations. */
export interface DelegationLineage {
  id: string;
  delegationDepth: number;
  maxDelegationDepth: number;
}

export interface SubagentRun extends DelegationLineage {
  parentRunId: string;
  taskPreview: string;
}

export function createRootDelegationLineage(
  maxDelegationDepth = 1,
): DelegationLineage {
  return { id: randomUUID(), delegationDepth: 0, maxDelegationDepth };
}

function createSubagentRun(
  parentRun: DelegationLineage,
  preview: string,
): SubagentRun {
  return {
    id: randomUUID(),
    parentRunId: parentRun.id,
    delegationDepth: parentRun.delegationDepth + 1,
    maxDelegationDepth: parentRun.maxDelegationDepth,
    taskPreview: preview,
  };
}

const parameters = Type.Object({
  task: Type.String({
    description: "Self-contained task to delegate to the subagent.",
  }),
});

export type SubagentDetails = {
  worker: "ephemeral";
  runId: string;
  parentRunId: string;
  status: SubagentStatus;
  taskPreview: string;
  resultPreview?: string;
};

export interface SubagentToolContext {
  parentRun: DelegationLineage;
  systemPrompt: string;
  model: Model<Api>;
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  convertToLlm: AgentExecutionOptions["convertToLlm"];
  getApiKey: AgentExecutionOptions["getApiKey"];
  onEvent?: (run: SubagentRun, event: AgentEvent) => void;
}

function details(
  run: SubagentRun,
  status: SubagentStatus,
  preview?: string,
): SubagentDetails {
  return {
    worker: "ephemeral",
    runId: run.id,
    parentRunId: run.parentRunId,
    status,
    taskPreview: run.taskPreview,
    ...(preview ? { resultPreview: preview } : {}),
  };
}

function progress(
  run: SubagentRun,
  status: SubagentStatus,
  text: string,
  preview: string | undefined,
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
): void {
  onUpdate?.({
    content: [{ type: "text", text }],
    details: details(run, status, preview),
  });
}

export async function runEphemeralAgent(
  context: SubagentToolContext,
  task: string,
  signal?: AbortSignal,
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
): Promise<AgentToolResult<SubagentDetails>> {
  if (
    context.parentRun.delegationDepth >= context.parentRun.maxDelegationDepth
  ) {
    throw new Error(
      `サブエージェントの最大深度に達しています (max=${context.parentRun.maxDelegationDepth})`,
    );
  }

  const childRun = createSubagentRun(context.parentRun, taskPreview(task));
  progress(childRun, "running", "Subagent started", undefined, onUpdate);

  try {
    const childSubagentTool = createSubagentTool({
      ...context,
      parentRun: childRun,
    });
    const childTools = context.tools
      .filter((tool) => tool.name !== "bot")
      .map((tool) => (tool.name === "subagent" ? childSubagentTool : tool));
    const execution = await runAgent({
      systemPrompt: context.systemPrompt,
      model: context.model,
      messages: [],
      tools: childTools,
      thinkingLevel: context.thinkingLevel,
      prompt: task,
      convertToLlm: context.convertToLlm,
      getApiKey: context.getApiKey,
      sessionId: childRun.id,
      signal,
      onEvent: (event) => {
        context.onEvent?.(childRun, event);
      },
    });
    if (signal?.aborted || execution.terminalStopReason === "aborted") {
      throw new Error("サブエージェントが中断されました");
    }
    if (execution.terminalStopReason === "error") {
      const reason = execution.terminalErrorMessage
        ? `: ${execution.terminalErrorMessage}`
        : "";
      throw new Error(`サブエージェントの実行に失敗しました${reason}`);
    }
    if (execution.response.trim() === "") {
      throw new Error("サブエージェントが空の応答で終了しました");
    }

    const preview = resultPreview(execution.response);
    progress(childRun, "completed", "Subagent completed", preview, onUpdate);
    return {
      content: [{ type: "text", text: execution.response }],
      details: details(childRun, "completed", preview),
    } satisfies AgentToolResult<SubagentDetails>;
  } catch (error) {
    progress(childRun, "failed", "Subagent failed", undefined, onUpdate);
    throw error;
  }
}

/** Create a one-shot delegation tool scoped to a single parent run. */
export function createSubagentTool(
  context: SubagentToolContext,
): AgentTool<typeof parameters, SubagentDetails> {
  return {
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate a self-contained task to an ephemeral subagent and receive its result. The subagent inherits the parent execution settings but does not share conversation history or persistent memory.",
    parameters,
    execute: async (_toolCallId, { task }, signal, onUpdate) =>
      runEphemeralAgent(context, task, signal, onUpdate),
  };
}
