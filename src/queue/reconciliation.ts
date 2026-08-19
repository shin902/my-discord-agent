import {
  listDispatchClaims,
  listLegacyDispatchClaims,
  markArticlesRead,
  releaseDispatchArticles,
  releaseLegacyDispatchClaim,
  resolveRssDbPath,
  restoreLegacyDispatchClaim,
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

function findQueueJob(
  repo: QueueRepository,
  dispatchJobId: string,
): QueueJob | undefined {
  // Current jobs use the RSS dispatch key as idempotency_key. The id fallback
  // keeps reconciliation compatible with old queue rows that had no dedicated
  // idempotency column value.
  return repo.findByIdempotencyKey(dispatchJobId) ?? repo.get(dispatchJobId);
}

function queuePayloadMatchesPath(
  payload: Record<string, unknown>,
  rssDbPath: string,
): boolean {
  const configuredPath =
    typeof payload.rssStatePath === "string" && payload.rssStatePath.length > 0
      ? payload.rssStatePath
      : undefined;
  return resolveRssDbPath(configuredPath) === rssDbPath;
}

/**
 * Find queue evidence for an old claim. The first RSS dispatch implementation
 * used dispatch_id itself as the queue idempotency key and did not persist
 * rssDispatchId in the payload, so that direct-key lookup is intentionally
 * retained alongside the modern payload match.
 */
function legacyQueueMappingCandidates(
  repo: QueueRepository,
  rssDbPath: string,
  dispatchId: string,
): string[] {
  const candidates = new Set<string>();
  const directJob =
    repo.findByIdempotencyKey(dispatchId) ?? repo.get(dispatchId);
  if (directJob) {
    const payload = directJob as QueueJob & Record<string, unknown>;
    if (
      (!payload.rssDispatchId || payload.rssDispatchId === dispatchId) &&
      queuePayloadMatchesPath(payload, rssDbPath)
    )
      candidates.add(dispatchId);
  }
  // A pruned job can leave only its idempotency tombstone. It does not prove
  // success, but it is still enough to restore the mapping so normal
  // reconciliation can release the unread claim without losing the audit key.
  if (repo.getIdempotencyRecord(dispatchId)) candidates.add(dispatchId);

  const rows = repo.db
    .prepare("SELECT id,idempotency_key,payload_json FROM jobs")
    .all() as Array<{
    id: string;
    idempotency_key: string | null;
    payload_json: string;
  }>;
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      payload.rssDispatchId !== dispatchId ||
      !queuePayloadMatchesPath(payload, rssDbPath)
    )
      continue;
    const queueKey =
      (typeof row.idempotency_key === "string" && row.idempotency_key) ||
      (typeof payload.idempotencyKey === "string" && payload.idempotencyKey) ||
      row.id;
    candidates.add(queueKey);
  }
  return [...candidates];
}

function repairLegacyClaims(
  repo: QueueRepository,
  db: Parameters<typeof listDispatchClaims>[0],
  rssDbPath: string,
): number {
  let released = 0;
  for (const claim of listLegacyDispatchClaims(db)) {
    const candidates = legacyQueueMappingCandidates(
      repo,
      rssDbPath,
      claim.dispatchId,
    );
    if (candidates.length === 1) {
      restoreLegacyDispatchClaim(
        db,
        claim.dispatchId,
        candidates[0],
        claim.articleIds,
      );
      continue;
    }
    // No queue evidence (or conflicting evidence) means this claim cannot be
    // safely acknowledged. Release it for a later retry and persist the exact
    // migration decision instead of silently making the article disappear.
    if (
      releaseLegacyDispatchClaim(
        db,
        claim.dispatchId,
        claim.articleIds,
        candidates.length === 0
          ? "missing_queue_mapping"
          : "ambiguous_queue_mapping",
      ) > 0
    )
      released++;
  }
  return released;
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
    const legacyClaim = listLegacyDispatchClaims(result.db).find(
      (candidate) => candidate.dispatchId === dispatchId,
    );
    if (legacyClaim && dispatchJobId !== undefined)
      restoreLegacyDispatchClaim(
        result.db,
        dispatchId,
        dispatchJobId,
        legacyClaim.articleIds,
      );
    if (
      legacyClaim &&
      dispatchJobId === undefined &&
      resolution === "dead_letter"
    )
      return releaseLegacyDispatchClaim(
        result.db,
        dispatchId,
        legacyClaim.articleIds,
        "missing_queue_mapping",
      ) > 0
        ? 1
        : 0;
    const claim = listDispatchClaims(result.db).find(
      (candidate) =>
        candidate.dispatchId === dispatchId &&
        (dispatchJobId === undefined ||
          candidate.dispatchJobId === dispatchJobId),
    );
    if (!claim) return 0;
    if (resolution === "completed") {
      markArticlesRead(
        result.db,
        claim.dispatchId,
        claim.dispatchJobId,
        claim.articleIds,
      );
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
  // Explicit paths are authoritative. Only standalone discovery with no
  // matching payload falls back to the process default database.
  const paths = new Set<string | undefined>(
    discovered.length > 0 ? discovered : [undefined],
  );
  let resolved = 0;
  for (const rssDbPath of paths) {
    const result = tryOpenRssDb(rssDbPath);
    if (!result.ok) continue; // Skips the default/missing DB best-effort.
    const db = result.db;
    try {
      // Repair legacy claims before taking the normal dispatch-claim snapshot;
      // otherwise a NULL dispatch_job_id is both unclaimable and invisible to
      // listDispatchClaims().
      resolved += repairLegacyClaims(repo, db, result.path);
      for (const claim of listDispatchClaims(db)) {
        const job = findQueueJob(repo, claim.dispatchJobId);
        const record = repo.getIdempotencyRecord(claim.dispatchJobId);
        if (hasSuccessfulResult(job)) {
          markArticlesRead(
            db,
            claim.dispatchId,
            claim.dispatchJobId,
            claim.articleIds,
          );
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
