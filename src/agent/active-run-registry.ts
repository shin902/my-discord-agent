export type ActiveRunControl = (
  instruction: string,
) => Promise<boolean> | boolean;
export type ActiveRunSteerResult = "accepted" | "unavailable" | "rejected";

export interface ActiveRunHandle {
  steer(instruction: string): Promise<boolean> | boolean;
}

type ActiveRun = {
  handle: ActiveRunHandle;
};

const activeRuns = new Map<string, ActiveRun>();

function runKey(groupName: string, sessionId: string): string {
  return `${groupName}\u0000${sessionId}`;
}

/** Register a ready Main Agent run for one (group, session) pair. */
export function registerActiveRun(
  groupName: string,
  sessionId: string,
  control: ActiveRunControl,
): () => void {
  const key = runKey(groupName, sessionId);
  if (activeRuns.has(key)) {
    throw new Error(`active run already exists: ${groupName}/${sessionId}`);
  }
  const run = { handle: { steer: control } };
  activeRuns.set(key, run);
  return () => {
    if (activeRuns.get(key) === run) activeRuns.delete(key);
  };
}

/** Capture the exact ready Main Agent run, if one exists now. */
export function acquireActiveRun(
  groupName: string,
  sessionId: string,
): ActiveRunHandle | undefined {
  return activeRuns.get(runKey(groupName, sessionId))?.handle;
}

/** Deliver steering to the one captured (group, session) run. */
export async function steerActiveRun(
  groupName: string,
  sessionId: string,
  instruction: string,
): Promise<ActiveRunSteerResult> {
  const handle = acquireActiveRun(groupName, sessionId);
  if (!handle) return "unavailable";
  try {
    return (await handle.steer(instruction)) === false
      ? "rejected"
      : "accepted";
  } catch (error) {
    console.error("[active-run] steering delivery failed:", error);
    return "rejected";
  }
}

/** Test/operator visibility without exposing runner handles. */
export function activeRunCount(): number {
  return activeRuns.size;
}

export function clearActiveRunsForTests(): void {
  activeRuns.clear();
}
