export type ActiveRunControl = (
  instruction: string,
) => Promise<boolean> | boolean;
export type ActiveRunStopResult =
  | { status: "aborted" }
  | { status: "force-killed" }
  | { status: "cleanup-failure"; error: string };
export type ActiveRunStop = () => Promise<ActiveRunStopResult>;

export interface ActiveRunHandle {
  steer(instruction: string): Promise<boolean> | boolean;
}

type ActiveRun = {
  handle: ActiveRunHandle;
  stop?: ActiveRunStop;
  stopPromise?: Promise<ActiveRunStopResult>;
};

const activeRuns = new Map<string, ActiveRun>();

function runKey(groupName: string, sessionId: string, agentId: string): string {
  return JSON.stringify([groupName, agentId, sessionId]);
}

/** Register a ready Agent run for one (group, owner, session) identity. */
export function registerActiveRun(
  groupName: string,
  sessionId: string,
  control: ActiveRunControl,
  stop?: ActiveRunStop,
  agentId = "main",
): () => void {
  const key = runKey(groupName, sessionId, agentId);
  if (activeRuns.has(key)) {
    throw new Error(
      `active run already exists: ${groupName}/${agentId}/${sessionId}`,
    );
  }
  const run = { handle: { steer: control }, stop };
  activeRuns.set(key, run);
  return () => {
    if (activeRuns.get(key) === run) activeRuns.delete(key);
  };
}

/** Capture the exact ready Agent run, if one exists now. */
export function acquireActiveRun(
  groupName: string,
  sessionId: string,
  agentId = "main",
): ActiveRunHandle | undefined {
  return activeRuns.get(runKey(groupName, sessionId, agentId))?.handle;
}

/** Stop only the exact active (group, owner, session) run. */
export async function stopActiveRun(
  groupName: string,
  sessionId: string,
  agentId = "main",
): Promise<ActiveRunStopResult | undefined> {
  const run = activeRuns.get(runKey(groupName, sessionId, agentId));
  if (!run?.stop) return undefined;
  if (run.stopPromise) return run.stopPromise;

  const stopPromise = run.stop();
  run.stopPromise = stopPromise;
  void stopPromise
    .finally(() => {
      if (run.stopPromise === stopPromise) run.stopPromise = undefined;
    })
    .catch(() => {
      // The caller observes the original stop promise; this prevents the
      // cleanup callback chain from becoming an unhandled rejection.
    });
  return stopPromise;
}

/** Test/operator visibility without exposing runner handles. */
export function activeRunCount(): number {
  return activeRuns.size;
}

export function clearActiveRunsForTests(): void {
  activeRuns.clear();
}
