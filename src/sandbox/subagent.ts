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
import {
  type AgentRun,
  type AgentRunStatus,
  agentRunRegistry,
} from "./agent-run.js";

const parameters = Type.Object({
  task: Type.String({
    description: "サブエージェントへ委譲する自己完結したタスク",
  }),
});

type SubagentDetails = {
  runId: string;
  parentRunId: string;
  status: AgentRunStatus;
};

export interface SubagentToolContext {
  parentRun: AgentRun;
  systemPrompt: string;
  model: Model<Api>;
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  convertToLlm: AgentExecutionOptions["convertToLlm"];
  getApiKey: AgentExecutionOptions["getApiKey"];
  onEvent?: (run: AgentRun, event: AgentEvent) => void;
}

function details(run: AgentRun): SubagentDetails {
  return {
    runId: run.id,
    parentRunId: run.parentRunId ?? "",
    status: run.status,
  };
}

function progress(
  run: AgentRun,
  text: string,
  onUpdate?: AgentToolUpdateCallback<SubagentDetails>,
): void {
  onUpdate?.({ content: [{ type: "text", text }], details: details(run) });
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

  const childRun = agentRunRegistry.create({
    kind: "subagent",
    parentRunId: context.parentRun.id,
  });
  progress(childRun, `Subagent ${childRun.id} started`, onUpdate);

  try {
    const childSubagentTool = createSubagentTool({
      ...context,
      parentRun: childRun,
    });
    const childTools = context.tools.map((tool) =>
      tool.name === "subagent" ? childSubagentTool : tool,
    );
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
        if (event.type === "tool_execution_start") {
          progress(
            childRun,
            `Subagent ${childRun.id}: ${event.toolName} started`,
            onUpdate,
          );
        } else if (event.type === "tool_execution_end") {
          progress(
            childRun,
            `Subagent ${childRun.id}: ${event.toolName} finished`,
            onUpdate,
          );
        }
      },
    });
    if (signal?.aborted) throw new Error("サブエージェントが中断されました");

    agentRunRegistry.complete(childRun.id, execution.response);
    progress(childRun, `Subagent ${childRun.id} completed`, onUpdate);
    return {
      content: [{ type: "text", text: execution.response }],
      details: details(childRun),
    } satisfies AgentToolResult<SubagentDetails>;
  } catch (error) {
    agentRunRegistry.fail(childRun.id);
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
      "自己完結したタスクをephemeral subagentへ委譲し、結果を受け取る。親の実行設定を引き継ぐが、会話履歴と永続memoryは共有しない。",
    parameters,
    execute: async (_toolCallId, { task }, signal, onUpdate) =>
      runEphemeralAgent(context, task, signal, onUpdate),
  };
}
