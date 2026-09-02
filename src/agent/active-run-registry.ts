export type ActiveRunControl = (
  instruction: string,
) => Promise<boolean> | boolean;
export type ActiveRunSteerResult = "accepted" | "unavailable" | "rejected";

type ActiveRun = {
  groupName: string;
  sessionId: string;
  control: ActiveRunControl;
};

const activeRuns = new Map<string, ActiveRun>();

function runKey(groupName: string, sessionId: string): string {
  return `${groupName}\u0000${sessionId}`;
}

/** Register the one runner currently executing a (group, session) pair. */
export function registerActiveRun(
  groupName: string,
  sessionId: string,
  control: ActiveRunControl,
): () => void {
  const key = runKey(groupName, sessionId);
  if (activeRuns.has(key)) {
    throw new Error(`active run already exists: ${groupName}/${sessionId}`);
  }
  const run = { groupName, sessionId, control };
  activeRuns.set(key, run);
  return () => {
    if (activeRuns.get(key) === run) activeRuns.delete(key);
  };
}

/** Deliver steering only to the exact active (group, session) run. */
export async function steerActiveRun(
  groupName: string,
  sessionId: string,
  instruction: string,
): Promise<ActiveRunSteerResult> {
  const run = activeRuns.get(runKey(groupName, sessionId));
  if (!run) return "unavailable";
  try {
    return (await run.control(instruction)) === false ? "rejected" : "accepted";
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
