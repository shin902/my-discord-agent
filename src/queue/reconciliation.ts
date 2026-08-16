import {
  listDispatchClaims,
  markArticlesRead,
  releaseDispatchArticles,
  tryOpenRssDb,
} from "../rss/store.js";
import {
  getQueueRepository,
  type QueueJob,
  type QueueRepository,
} from "./repository.js";

export type RssDispatchResolution = "completed" | "dead_letter";

function hasSuccessfulResult(job: QueueJob | undefined): boolean {
  return (
    job?.status === "completed" &&
    job.succeeded === true &&
    job.terminalState === "succeeded"
  );
}

/**
 * Settle one RSS dispatch after its associated queue job reaches a terminal
 * state. This is deliberately targeted: a live queue transition must not
 * release another dispatch that is still between claim and queue admission.
 */
export function settleRssDispatch(
  rssDbPath: string | undefined,
  dispatchId: string,
  dispatchJobId: string | undefined,
  resolution: RssDispatchResolution,
): number {
  const result = tryOpenRssDb(rssDbPath);
  if (!result.ok) return 0;
  try {
    const claim = listDispatchClaims(result.db).find(
      (candidate) =>
        candidate.dispatchId === dispatchId &&
        (dispatchJobId === undefined ||
          candidate.dispatchJobId === dispatchJobId),
    );
    if (!claim) return 0;
    if (resolution === "completed") {
      markArticlesRead(result.db, claim.articleIds);
    } else {
      releaseDispatchArticles(result.db, claim.dispatchId, claim.articleIds);
    }
    return 1;
  } finally {
    result.db.close();
  }
}

/**
 * Resolve the two crash windows between RSS claiming, queue insertion, and read marking.
 * A successful queue result makes its articles read; a missing/failed/non-success
 * terminal job releases its claim without marking the articles read.
 */
export function reconcileRssDispatches(
  repo: QueueRepository = getQueueRepository(),
  rssDbPaths?: string | readonly string[],
): number {
  const configured = typeof rssDbPaths === "string" ? [rssDbPaths] : rssDbPaths;
  // Caller-supplied paths (startup passes the merged repository + cron path
  // list) are authoritative: listRssStatePaths() parses every job payload, so
  // discovering it again here would duplicate that full scan. Only standalone
  // callers that pass no path argument fall back to queue-payload discovery.
  const discovered =
    configured === undefined ? repo.listRssStatePaths() : configured;
  const paths = new Set<string | undefined>([undefined, ...discovered]);
  let resolved = 0;
  for (const rssDbPath of paths) {
    const result = tryOpenRssDb(rssDbPath);
    if (!result.ok) continue; // Skips the default/missing DB best-effort.
    const db = result.db;
    try {
      for (const claim of listDispatchClaims(db)) {
        const job = repo.findByIdempotencyKey(claim.dispatchJobId);
        const record = repo.getIdempotencyRecord(claim.dispatchJobId);
        if (hasSuccessfulResult(job)) {
          markArticlesRead(db, claim.articleIds);
          resolved++;
        } else if (
          job?.status === "completed" ||
          job?.status === "dead_letter" ||
          record?.status === "completed" ||
          record?.status === "dead_letter" ||
          !record
        ) {
          // A completed job or tombstone can still lack durable success
          // evidence (for example, an empty response or a pruned job). Those
          // claims remain unread but must be released so a later RSS run can
          // retry them.
          releaseDispatchArticles(db, claim.dispatchId, claim.articleIds);
          resolved++;
        }
      }
    } catch {
      // A malformed RSS schema must not prevent unrelated startup paths.
    } finally {
      db.close();
    }
  }
  return resolved;
}
