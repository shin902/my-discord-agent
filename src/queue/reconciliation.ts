import { listDispatchClaims, markArticlesRead, openRssDb, releaseDispatchArticles } from "../rss/store.js";
import { getQueueRepository, type QueueRepository } from "./repository.js";

/**
 * Resolve the two crash windows between RSS claiming, queue insertion, and read marking.
 * A completed queue job makes its articles read; a missing/failed job releases its claim.
 */
export function reconcileRssDispatches(
  repo: QueueRepository = getQueueRepository(),
  rssDbPaths?: string | readonly string[],
): number {
  const configuredPaths = typeof rssDbPaths === "string"
    ? [rssDbPaths]
    : rssDbPaths ?? [];
  const paths = new Set<string | undefined>([undefined, ...configuredPaths, ...repo.listRssStatePaths()]);
  let resolved = 0;
  for (const rssDbPath of paths) {
    const db = openRssDb(rssDbPath);
    try {
      for (const claim of listDispatchClaims(db)) {
        const job = repo.findByIdempotencyKey(claim.dispatchJobId);
        const record = repo.getIdempotencyRecord(claim.dispatchJobId);
        if (job?.status === "completed" || record?.status === "completed") {
          markArticlesRead(db, claim.articleIds);
          resolved++;
        } else if (job?.status === "dead_letter" || record?.status === "dead_letter" || !record) {
          releaseDispatchArticles(db, claim.dispatchId, claim.articleIds);
          resolved++;
        }
      }
    } finally {
      db.close();
    }
  }
  return resolved;
}
