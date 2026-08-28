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
}

/** In-memory run registry for current-process orchestration and future observers. */
export class AgentRunRegistry {
  private readonly runs = new Map<string, AgentRun>();

  create(options: {
    kind: AgentRunKind;
    parentRunId?: string;
    delegationDepth?: number;
    maxDelegationDepth?: number;
  }): AgentRun {
    const parent = options.parentRunId
      ? this.runs.get(options.parentRunId)
      : undefined;
    if (options.parentRunId && !parent) {
      throw new Error(`親runが見つかりません: ${options.parentRunId}`);
    }

    const run: AgentRun = {
      id: randomUUID(),
      ...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
      kind: options.kind,
      status: "running",
      delegationDepth:
        options.delegationDepth ?? (parent ? parent.delegationDepth + 1 : 0),
      maxDelegationDepth:
        options.maxDelegationDepth ?? parent?.maxDelegationDepth ?? 1,
      startedAt: Date.now(),
    };
    this.runs.set(run.id, run);
    return run;
  }

  complete(id: string, result?: string): AgentRun {
    return this.update(id, {
      status: "completed",
      completedAt: Date.now(),
      ...(result === undefined ? {} : { result }),
    });
  }

  fail(id: string): AgentRun {
    return this.update(id, { status: "failed", completedAt: Date.now() });
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
}

export const agentRunRegistry = new AgentRunRegistry();
