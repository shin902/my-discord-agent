import {
  listDispatchClaims,
  markArticlesRead,
  releaseDispatchArticles,
  tryOpenRssDb,
} from "../rss/store.js";
import { getQueueRepository, type QueueRepository } from "./repository.js";

/**
 * Resolve the two crash windows between RSS claiming, queue insertion, and read marking.
 * A completed queue job makes its articles read; a missing/failed job releases its claim.
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
        if (job?.status === "completed" || record?.status === "completed") {
          markArticlesRead(db, claim.articleIds);
          resolved++;
        } else if (
          job?.status === "dead_letter" ||
          record?.status === "dead_letter" ||
          !record
        ) {
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
