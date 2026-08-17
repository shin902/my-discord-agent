import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimUnreadArticles,
  listLegacyDispatchClaims,
  listUnreadArticles,
  markArticlesRead,
  openRssDb,
  releaseDispatchArticles,
  saveFeedEntries,
} from "./store.js";

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function makeRssPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rss-store-test-"));
  tempDirs.push(dir);
  return join(dir, "rss.sqlite3");
}

describe("markArticlesRead dispatch fencing", () => {
  it("does not acknowledge an article after its dispatch was released and reassigned", async () => {
    const db = openRssDb(await makeRssPath());
    try {
      saveFeedEntries(db, {
        url: "https://example.com/fenced-feed.xml",
        parsedName: "Feed",
        etag: null,
        lastModified: null,
        entries: [
          {
            entryId: "article-1",
            title: "Article",
            link: "https://example.com/article",
            publishedAt: "2026-08-01",
            summary: "Summary",
          },
        ],
        markInitialAsRead: false,
      });

      const first = claimUnreadArticles(db, "cron-rss", 10);
      expect(first).toBeDefined();
      const firstDispatch = first as NonNullable<typeof first>;
      releaseDispatchArticles(
        db,
        firstDispatch.id,
        firstDispatch.articles.map((article) => article.id),
      );
      const second = claimUnreadArticles(db, "cron-rss", 10);
      expect(second).toBeDefined();
      const secondDispatch = second as NonNullable<typeof second>;
      const articleIds = secondDispatch.articles.map((article) => article.id);

      // A dispatch is a composite identity: matching only one identifier must
      // not acknowledge the currently assigned claim.
      markArticlesRead(db, secondDispatch.id, firstDispatch.jobId, articleIds);
      expect(
        db
          .prepare(
            "SELECT read_at, dispatch_id, dispatch_job_id FROM rss_articles",
          )
          .get(),
      ).toEqual({
        read_at: null,
        dispatch_id: secondDispatch.id,
        dispatch_job_id: secondDispatch.jobId,
      });

      markArticlesRead(
        db,
        firstDispatch.id,
        firstDispatch.jobId,
        firstDispatch.articles.map((article) => article.id),
      );
      expect(
        db
          .prepare(
            "SELECT read_at, dispatch_id, dispatch_job_id FROM rss_articles",
          )
          .get(),
      ).toEqual({
        read_at: null,
        dispatch_id: secondDispatch.id,
        dispatch_job_id: secondDispatch.jobId,
      });

      markArticlesRead(
        db,
        secondDispatch.id,
        secondDispatch.jobId,
        secondDispatch.articles.map((article) => article.id),
      );
      expect(listUnreadArticles(db, 10)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("listUnreadArticles row mapping", () => {
  it("maps every selected row field to the UnreadArticle shape", async () => {
    const db = openRssDb(await makeRssPath());
    try {
      saveFeedEntries(db, {
        url: "https://example.com/feed.xml",
        configuredName: "Example Feed",
        parsedName: "",
        etag: null,
        lastModified: null,
        entries: [
          {
            entryId: "article-1",
            title: "Article title",
            link: "https://example.com/article-1",
            publishedAt: "2026-08-01T00:00:00.000Z",
            summary: "Article summary",
          },
        ],
        markInitialAsRead: false,
      });

      expect(listUnreadArticles(db, 10)).toEqual([
        {
          id: 1,
          feedName: "Example Feed",
          feedUrl: "https://example.com/feed.xml",
          title: "Article title",
          link: "https://example.com/article-1",
          publishedAt: "2026-08-01T00:00:00.000Z",
          summary: "Article summary",
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("falls back to the feed URL when the feed name is null", async () => {
    const db = openRssDb(await makeRssPath());
    try {
      saveFeedEntries(db, {
        url: "https://example.com/named-feed.xml",
        configuredName: "",
        parsedName: "",
        etag: null,
        lastModified: null,
        entries: [
          {
            entryId: "article-1",
            title: "Article title",
            link: "https://example.com/article-1",
            publishedAt: "2026-08-01T00:00:00.000Z",
            summary: "Article summary",
          },
        ],
        markInitialAsRead: false,
      });

      expect(listUnreadArticles(db, 10)[0].feedName).toBe(
        "https://example.com/named-feed.xml",
      );
    } finally {
      db.close();
    }
  });
});

describe("RSS dispatch migration shape", () => {
  it("adds the repair log while preserving a legacy claim for reconciliation", async () => {
    const dbPath = await makeRssPath();
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE rss_feeds (
        id INTEGER PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        name TEXT,
        etag TEXT,
        last_modified TEXT,
        initialized_at TEXT NOT NULL,
        last_fetched_at TEXT NOT NULL
      );
      CREATE TABLE rss_articles (
        id INTEGER PRIMARY KEY,
        feed_id INTEGER NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
        entry_id TEXT NOT NULL,
        title TEXT NOT NULL,
        link TEXT NOT NULL,
        published_at TEXT NOT NULL,
        summary TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        read_at TEXT,
        dispatch_id TEXT,
        UNIQUE(feed_id, entry_id)
      );
      INSERT INTO rss_feeds(url,name,initialized_at,last_fetched_at)
      VALUES('https://example.com/legacy.xml','Legacy','2020-01-01','2020-01-01');
      INSERT INTO rss_articles(
        feed_id,entry_id,title,link,published_at,summary,collected_at,read_at,dispatch_id
      ) VALUES(1,'entry-1','Article','https://example.com/article','2020-01-01','',
        '2020-01-01',NULL,'legacy-dispatch');
    `);
    legacy.close();

    const db = openRssDb(dbPath);
    try {
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='rss_dispatch_repairs'",
          )
          .get(),
      ).toBeDefined();
      expect(listLegacyDispatchClaims(db)).toEqual([
        { dispatchId: "legacy-dispatch", articleIds: [1] },
      ]);
      expect(
        db
          .prepare(
            "SELECT dispatch_id,dispatch_job_id FROM rss_articles WHERE id=1",
          )
          .get(),
      ).toEqual({ dispatch_id: "legacy-dispatch", dispatch_job_id: null });
    } finally {
      db.close();
    }
  });
});
