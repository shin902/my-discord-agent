import type Database from "better-sqlite3";
import { z } from "zod";

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
}

/** Inspect RSS claims against runtime jobs without mutating either source of truth. */
export function inspectRssReconciliation(
  rssDb: Database.Database,
  runtimeDb: Database.Database,
): RssReconciliationReport {
  const count = z.object({ count: z.number() });
  const feeds = count.parse(
    rssDb.prepare("SELECT COUNT(*) AS count FROM rss_feeds").get(),
  ).count;
  const articles = count.parse(
    rssDb.prepare("SELECT COUNT(*) AS count FROM rss_articles").get(),
  ).count;
  const unread = count.parse(
    rssDb
      .prepare(
        "SELECT COUNT(*) AS count FROM rss_articles WHERE read_at IS NULL",
      )
      .get(),
  ).count;
  const claims = z
    .array(
      z.object({
        dispatch_id: z.string(),
        dispatch_job_id: z.string().nullable(),
        article_ids: z.string(),
      }),
    )
    .parse(
      rssDb
        .prepare(`
    SELECT dispatch_id, dispatch_job_id, GROUP_CONCAT(id) AS article_ids
    FROM rss_articles
    WHERE read_at IS NULL AND dispatch_id IS NOT NULL
    GROUP BY dispatch_id, dispatch_job_id
  `)
        .all(),
    );
  const orphanDispatches: Array<{ dispatchId: string; jobId: string }> = [];
  const completedTombstones: Array<{ dispatchId: string; jobId: string }> = [];
  const migrationAnomalies: RssDispatchAnomaly[] = [];
  for (const claim of claims) {
    const articleIds = claim.article_ids.split(",").map(Number);
    if (claim.dispatch_job_id === null) {
      migrationAnomalies.push({
        dispatchId: claim.dispatch_id,
        jobId: null,
        articleIds,
        reason: "missing_dispatch_job_id",
      });
      continue;
    }
    const jobRaw = runtimeDb
      .prepare("SELECT status FROM jobs WHERE idempotency_key=? OR id=?")
      .get(claim.dispatch_job_id, claim.dispatch_job_id);
    const job = z
      .object({ status: z.string().optional() })
      .nullable()
      .optional()
      .parse(jobRaw);
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
  };
}
