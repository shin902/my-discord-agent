import type Database from "better-sqlite3";
import {
  type DispatchRepairRecord,
  listDispatchRepairRecords,
} from "./store.js";

export interface RssDispatchAnomaly {
  dispatchId: string;
  jobId: string | null;
  articleIds: number[];
  reason: "missing_dispatch_job_id";
}

export interface RssReconciliationReport {
  feeds: number;
  articles: number;
  unread: number;
  claimed: number;
  orphanDispatches: Array<{ dispatchId: string; jobId: string }>;
  completedTombstones: Array<{ dispatchId: string; jobId: string }>;
  migrationAnomalies: RssDispatchAnomaly[];
  migrationRepairs: DispatchRepairRecord[];
}

/** Inspect RSS claims against runtime jobs without mutating either source of truth. */
export function inspectRssReconciliation(
  rssDb: Database.Database,
  runtimeDb: Database.Database,
): RssReconciliationReport {
  const feeds = Number(
    (
      rssDb.prepare("SELECT COUNT(*) AS count FROM rss_feeds").get() as {
        count: number;
      }
    ).count,
  );
  const articles = Number(
    (
      rssDb.prepare("SELECT COUNT(*) AS count FROM rss_articles").get() as {
        count: number;
      }
    ).count,
  );
  const unread = Number(
    (
      rssDb
        .prepare(
          "SELECT COUNT(*) AS count FROM rss_articles WHERE read_at IS NULL",
        )
        .get() as { count: number }
    ).count,
  );
  const claims = rssDb
    .prepare(`
    SELECT dispatch_id, dispatch_job_id, GROUP_CONCAT(id) AS article_ids
    FROM rss_articles
    WHERE read_at IS NULL AND dispatch_id IS NOT NULL
    GROUP BY dispatch_id, dispatch_job_id
  `)
    .all() as Array<{
    dispatch_id: string;
    dispatch_job_id: string | null;
    article_ids: string;
  }>;
  const orphanDispatches: Array<{ dispatchId: string; jobId: string }> = [];
  const completedTombstones: Array<{ dispatchId: string; jobId: string }> = [];
  const migrationAnomalies: RssDispatchAnomaly[] = [];
  for (const claim of claims) {
    const articleIds = claim.article_ids.split(",").map(Number);
    if (
      claim.dispatch_job_id === null ||
      claim.dispatch_job_id.trim().length === 0
    ) {
      migrationAnomalies.push({
        dispatchId: claim.dispatch_id,
        jobId: null,
        articleIds,
        reason: "missing_dispatch_job_id",
      });
      continue;
    }
    const job = runtimeDb
      .prepare("SELECT status FROM jobs WHERE idempotency_key=? OR id=?")
      .get(claim.dispatch_job_id, claim.dispatch_job_id) as
      | { status?: string }
      | undefined;
    if (!job)
      orphanDispatches.push({
        dispatchId: claim.dispatch_id,
        jobId: claim.dispatch_job_id,
      });
    else if (job.status === "completed")
      completedTombstones.push({
        dispatchId: claim.dispatch_id,
        jobId: claim.dispatch_job_id,
      });
  }
  return {
    feeds,
    articles,
    unread,
    claimed: claims.length,
    orphanDispatches,
    completedTombstones,
    migrationAnomalies,
    migrationRepairs: listDispatchRepairRecords(rssDb),
  };
}
