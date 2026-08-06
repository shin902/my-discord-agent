import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimUnreadArticles, listUnreadArticles, openRssDb, saveFeedEntries } from "../rss/store.js";
import { reconcileRssDispatches } from "./reconciliation.js";
import { QueueRepository, openRuntimeDb } from "./repository.js";

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makeRssPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rss-reconcile-test-"));
  tempDirs.push(dir);
  return join(dir, "custom-rss.sqlite3");
}

function seedUnread(path: string): void {
  const db = openRssDb(path);
  try {
    saveFeedEntries(db, {
      url: "https://example.com/feed.xml",
      parsedName: "Feed",
      etag: null,
      lastModified: null,
      entries: [{ entryId: "article-1", title: "Article", link: "https://example.com/article", publishedAt: "2026-08-01", summary: "Summary" }],
      markInitialAsRead: false,
    });
  } finally {
    db.close();
  }
}

describe("reconcileRssDispatches", () => {
  it("uses stored dispatch_job_id and discovers custom paths from queue payloads", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const rssDb = openRssDb(rssPath);
      const dispatch = claimUnreadArticles(rssDb, "cron-rss", 10);
      expect(dispatch).toBeDefined();
      rssDb.close();
      const queued = repo.enqueue({
        channelId: "channel",
        groupName: "rss",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
        rssDispatchId: dispatch!.id,
        rssStatePath: rssPath,
      }, { idempotencyKey: dispatch!.jobId });
      const claimed = repo.claim("worker", 60_000);
      repo.complete(queued.job.id, claimed!.fencingToken);

      expect(reconcileRssDispatches(repo)).toBe(1);
      const check = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(check, 10)).toEqual([]);
      } finally {
        check.close();
      }
    } finally {
      repo.close();
    }
  });

  it("converges reads from a completed idempotency tombstone without a jobs row", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const rssDb = openRssDb(rssPath);
      const dispatch = claimUnreadArticles(rssDb, "cron-rss", 10);
      rssDb.close();
      const completedAt = new Date().toISOString();
      repo.db.prepare("INSERT INTO idempotency_keys(key,job_id,status,created_at,completed_at) VALUES(?,?,?,?,?)").run(dispatch!.jobId, null, "completed", completedAt, completedAt);

      expect(reconcileRssDispatches(repo, rssPath)).toBe(1);
      const check = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(check, 10)).toEqual([]);
      } finally {
        check.close();
      }
    } finally {
      repo.close();
    }
  });
});
