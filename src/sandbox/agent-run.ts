import { randomUUID } from "node:crypto";

export type AgentRunKind = "root" | "subagent";
export type AgentRunStatus = "running" | "completed" | "failed";

export interface AgentRun {
  id: string;
  parentRunId?: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  delegationDepth: number;
  maxDelegationDepth: number;
  taskPreview?: string;
  resultPreview?: string;
}

export type SubagentRun = AgentRun & {
  kind: "subagent";
  parentRunId: string;
  taskPreview: string;
};

type RootRunOptions = {
  maxDelegationDepth?: number;
};

/** Create the run record used for one root agent execution. */
export function createRootAgentRun(options: RootRunOptions = {}): AgentRun {
  return {
    id: randomUUID(),
    kind: "root",
    status: "running",
    delegationDepth: 0,
    maxDelegationDepth: options.maxDelegationDepth ?? 1,
  };
}

/** Create an ephemeral child run from its live parent run. */
export function createSubagentRun(
  parentRun: AgentRun,
  taskPreview: string,
): SubagentRun {
  return {
    id: randomUUID(),
    parentRunId: parentRun.id,
    kind: "subagent",
    status: "running",
    delegationDepth: parentRun.delegationDepth + 1,
    maxDelegationDepth: parentRun.maxDelegationDepth,
    taskPreview,
  };
}

export function completeAgentRun(run: AgentRun): AgentRun {
  run.status = "completed";
  return run;
}

export function failAgentRun(run: AgentRun): AgentRun {
  run.status = "failed";
  return run;
}
