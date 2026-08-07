import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { openRssDb, resolveRssDbPath } from "../rss/store.js";
import { reconcileRssDispatches } from "./reconciliation.js";
import { runRuntimeOperator } from "./operator.js";
import { QueueRepository, openRuntimeDb } from "./repository.js";

describe("runtime operator", () => {
  it("runs health and metrics while keeping retention opt-in and dry-run by default", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const job = repo.enqueue({
        channelId: "c",
        groupName: "g",
        sessionId: "s",
        content: "hello",
        timestamp: "2020-01-01T00:00:00.000Z",
      }).job;
      repo.db
        .prepare(
          "UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id=?",
        )
        .run("2020-01-01T00:00:00.000Z", job.id);
      const report = await runRuntimeOperator(repo.db, {
        retention: { policy: { jobs: { completed: 1 } } },
      });
      expect(report.health.ok).toBe(true);
      expect(report.observability.queue.byStatus.completed).toBe(1);
      expect(report.retention).toMatchObject({
        dryRun: true,
        planned: 1,
        deleted: 0,
        archived: 0,
      });
      expect(repo.get(job.id)).toBeDefined();
    } finally {
      repo.close();
    }
  });
  it("passes the RSS store through so reconciliation alerts are visible", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "operator-rss-"));
    const rssDb = openRssDb(join(dir, "rss.sqlite3"));
    try {
      rssDb
        .prepare(
          "INSERT INTO rss_feeds(url,name,initialized_at,last_fetched_at) VALUES(?,?,?,?)",
        )
        .run(
          "https://example.com/feed",
          "feed",
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:00:00.000Z",
        );
      rssDb
        .prepare(
          "INSERT INTO rss_articles(feed_id,entry_id,title,link,published_at,summary,collected_at,read_at,dispatch_id,dispatch_job_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          1,
          "entry",
          "title",
          "https://example.com/item",
          "2020-01-01T00:00:00.000Z",
          "",
          "2020-01-01T00:00:00.000Z",
          null,
          "dispatch-1",
          "missing-job",
        );
      const report = await runRuntimeOperator(repo.db, { rssDb });
      expect(report.observability.rss).toMatchObject({
        feeds: 1,
        articles: 1,
        claimed: 1,
        orphanDispatches: ["missing-job"],
      });
      expect(report.observability.alerts).toContain("RSS orphan dispatches: 1");
    } finally {
      rssDb.close();
      repo.close();
    }
  });
  it("reports RSS claims missing dispatch_job_id as migration anomalies with dispatch evidence", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "operator-rss-anomaly-"));
    const rssDb = openRssDb(join(dir, "rss.sqlite3"));
    try {
      rssDb
        .prepare(
          "INSERT INTO rss_feeds(url,name,initialized_at,last_fetched_at) VALUES(?,?,?,?)",
        )
        .run(
          "https://example.com/feed",
          "feed",
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:00:00.000Z",
        );
      rssDb
        .prepare(
          "INSERT INTO rss_articles(feed_id,entry_id,title,link,published_at,summary,collected_at,read_at,dispatch_id,dispatch_job_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          1,
          "entry",
          "title",
          "https://example.com/item",
          "2020-01-01T00:00:00.000Z",
          "",
          "2020-01-01T00:00:00.000Z",
          null,
          "dispatch-missing-job",
          null,
        );

      const report = await runRuntimeOperator(repo.db, { rssDb });

      expect(report.observability.rss).toMatchObject({
        claimed: 1,
        migrationAnomalies: [
          {
            dispatchId: "dispatch-missing-job",
            jobId: null,
            articleIds: [1],
            reason: "missing_dispatch_job_id",
          },
        ],
      });
      expect(report.observability.alerts).toContain(
        "RSS migration anomalies (missing dispatch_job_id): 1 [dispatch-missing-job]",
      );
    } finally {
      rssDb.close();
      repo.close();
    }
  });
  it("inspects custom rssStatePath databases and exposes per-path metrics", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "operator-rss-custom-"));
    const customPath = join(dir, "custom.sqlite3");
    const rssDb = openRssDb(customPath);
    try {
      rssDb
        .prepare(
          "INSERT INTO rss_feeds(url,name,initialized_at,last_fetched_at) VALUES(?,?,?,?)",
        )
        .run(
          "https://example.com/custom",
          "custom",
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:00:00.000Z",
        );
      rssDb
        .prepare(
          "INSERT INTO rss_articles(feed_id,entry_id,title,link,published_at,summary,collected_at,read_at,dispatch_id,dispatch_job_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          1,
          "entry",
          "title",
          "https://example.com/custom/item",
          "2020-01-01T00:00:00.000Z",
          "",
          "2020-01-01T00:00:00.000Z",
          null,
          "dispatch-custom",
          "missing-custom-job",
        );

      const report = await runRuntimeOperator(repo.db, {
        rssDbPaths: [customPath],
      });

      expect(
        report.observability.rss?.byPath[resolveRssDbPath(customPath)],
      ).toMatchObject({
        feeds: 1,
        articles: 1,
        claimed: 1,
        orphanDispatches: ["missing-custom-job"],
      });
      expect(report.observability.alerts).toContain("RSS orphan dispatches: 1");
    } finally {
      rssDb.close();
      repo.close();
    }
  });

  it("uses post-reconciliation RSS state for startup alerts", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "operator-rss-reconcile-"));
    const customPath = join(dir, "custom.sqlite3");
    const rssDb = openRssDb(customPath);
    try {
      rssDb
        .prepare(
          "INSERT INTO rss_feeds(url,name,initialized_at,last_fetched_at) VALUES(?,?,?,?)",
        )
        .run(
          "https://example.com/reconcile",
          "reconcile",
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:00:00.000Z",
        );
      rssDb
        .prepare(
          "INSERT INTO rss_articles(feed_id,entry_id,title,link,published_at,summary,collected_at,read_at,dispatch_id,dispatch_job_id) VALUES(?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          1,
          "entry",
          "title",
          "https://example.com/reconcile/item",
          "2020-01-01T00:00:00.000Z",
          "",
          "2020-01-01T00:00:00.000Z",
          null,
          "dispatch-reconcile",
          "missing-reconcile-job",
        );

      expect(reconcileRssDispatches(repo, [customPath])).toBe(1);
      const report = await runRuntimeOperator(repo.db, {
        rssDbPaths: [customPath],
      });

      expect(
        report.observability.rss?.byPath[resolveRssDbPath(customPath)],
      ).toMatchObject({ claimed: 0, orphanDispatches: [] });
      expect(
        report.observability.alerts.some((alert) =>
          alert.startsWith("RSS orphan dispatches:"),
        ),
      ).toBe(false);
    } finally {
      rssDb.close();
      repo.close();
    }
  });
});
