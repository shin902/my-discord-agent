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
  startedAt: number;
  completedAt?: number;
  result?: string;
  taskPreview?: string;
  resultPreview?: string;
}

export type SubagentRun = AgentRun & {
  kind: "subagent";
  parentRunId: string;
  taskPreview: string;
};

type AgentRunCreateOptions = {
  delegationDepth?: number;
  maxDelegationDepth?: number;
};
type RootRunCreateOptions = AgentRunCreateOptions & {
  kind: "root";
  parentRunId?: never;
  taskPreview?: never;
};
type SubagentRunCreateOptions = AgentRunCreateOptions & {
  kind: "subagent";
  parentRunId: string;
  taskPreview: string;
};

/** In-memory run registry for current-process orchestration and future observers. */
export class AgentRunRegistry {
  private readonly runs = new Map<string, AgentRun>();
  private readonly maxCompletedRuns: number;

  constructor(maxCompletedRuns = 100) {
    if (!Number.isInteger(maxCompletedRuns) || maxCompletedRuns < 0) {
      throw new Error("maxCompletedRuns must be a non-negative integer");
    }
    this.maxCompletedRuns = maxCompletedRuns;
  }

  create(options: RootRunCreateOptions): AgentRun;
  create(options: SubagentRunCreateOptions): SubagentRun;
  create(options: RootRunCreateOptions | SubagentRunCreateOptions): AgentRun {
    const parent = options.parentRunId
      ? this.runs.get(options.parentRunId)
      : undefined;
    if (options.parentRunId && !parent) {
      throw new Error(`親runが見つかりません: ${options.parentRunId}`);
    }

    const run: AgentRun = {
      id: randomUUID(),
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      ...(options.kind === "subagent"
        ? { taskPreview: options.taskPreview }
        : {}),
      kind: options.kind,
      status: "running",
      delegationDepth:
        options.delegationDepth ?? (parent ? parent.delegationDepth + 1 : 0),
      maxDelegationDepth:
        options.maxDelegationDepth ?? parent?.maxDelegationDepth ?? 1,
      startedAt: Date.now(),
    };
    this.runs.set(run.id, run);
    this.pruneCompletedRuns();
    return run;
  }

  complete(id: string, result?: string): AgentRun {
    const run = this.update(id, {
      status: "completed",
      completedAt: Date.now(),
      ...(result === undefined ? {} : { result }),
    });
    this.pruneCompletedRuns();
    return run;
  }

  fail(id: string): AgentRun {
    const run = this.update(id, { status: "failed", completedAt: Date.now() });
    this.pruneCompletedRuns();
    return run;
  }

  get(id: string): AgentRun | undefined {
    return this.runs.get(id);
  }

  list(): AgentRun[] {
    return [...this.runs.values()];
  }

  private update(id: string, patch: Partial<AgentRun>): AgentRun {
    const run = this.runs.get(id);
    if (!run) throw new Error(`runが見つかりません: ${id}`);
    Object.assign(run, patch);
    return run;
  }

  private pruneCompletedRuns(): void {
    const completed = [...this.runs.values()]
      .filter((run) => run.status !== "running")
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
    const removeCount = completed.length - this.maxCompletedRuns;
    for (const run of completed.slice(0, Math.max(0, removeCount))) {
      this.runs.delete(run.id);
    }
  }
}

export const agentRunRegistry = new AgentRunRegistry();
