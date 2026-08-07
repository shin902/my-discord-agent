import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expectDefined } from "../test-utils.js";
import {
  claimUnreadArticles,
  markArticlesRead,
  openRssDb,
  saveFeedEntries,
} from "../rss/store.js";

describe("RSS dispatch batch idempotency", () => {
  it("assigns a fresh queue key to each later batch for the same cron", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rss-batch-test-"));
    const db = openRssDb(join(dir, "rss.sqlite3"));
    try {
      const input = {
        url: "https://example.com/feed.xml",
        parsedName: "Feed",
        etag: null,
        lastModified: null,
        markInitialAsRead: false,
      } as const;
      saveFeedEntries(db, {
        ...input,
        entries: [
          {
            entryId: "one",
            title: "One",
            link: "https://example.com/one",
            publishedAt: "",
            summary: "",
          },
        ],
      });
      const first = claimUnreadArticles(db, "cron-rss", 10);
      expect(first).toBeDefined();
      markArticlesRead(
        db,
        expectDefined(first).articles.map((article) => article.id),
      );
      saveFeedEntries(db, {
        ...input,
        entries: [
          {
            entryId: "two",
            title: "Two",
            link: "https://example.com/two",
            publishedAt: "",
            summary: "",
          },
        ],
      });
      const second = claimUnreadArticles(db, "cron-rss", 10);
      expect(second?.articles.map((article) => article.title)).toEqual(["Two"]);
      expect(second?.jobId).not.toBe(first?.jobId);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not recover a pending batch for a dispatch key containing SQL wildcards", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rss-metachar-test-"));
    const db = openRssDb(join(dir, "rss.sqlite3"));
    try {
      const input = {
        url: "https://example.com/metachar-feed.xml",
        parsedName: "Feed",
        etag: null,
        lastModified: null,
        markInitialAsRead: false,
      } as const;
      saveFeedEntries(db, {
        ...input,
        entries: [
          {
            entryId: "one",
            title: "One",
            link: "https://example.com/one",
            publishedAt: "",
            summary: "",
          },
        ],
      });

      expect(claimUnreadArticles(db, "cronA", 10)).toBeDefined();
      saveFeedEntries(db, {
        ...input,
        entries: [
          {
            entryId: "two",
            title: "Two",
            link: "https://example.com/two",
            publishedAt: "",
            summary: "",
          },
        ],
      });
      const first = claimUnreadArticles(db, "a", 10);
      expect(first).toBeDefined();
      expect(
        claimUnreadArticles(db, expectDefined(first).jobId, 10),
      ).toBeUndefined();
      expect(claimUnreadArticles(db, "cron%", 10)).toBeUndefined();
      expect(claimUnreadArticles(db, "cron_", 10)).toBeUndefined();
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("backfills the exact owner key for legacy pending batches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rss-legacy-owner-test-"));
    const dbPath = join(dir, "rss.sqlite3");
    const db = openRssDb(dbPath);
    try {
      const input = {
        url: "https://example.com/legacy-owner-feed.xml",
        parsedName: "Feed",
        etag: null,
        lastModified: null,
        markInitialAsRead: false,
      } as const;
      saveFeedEntries(db, {
        ...input,
        entries: [
          {
            entryId: "one",
            title: "One",
            link: "https://example.com/one",
            publishedAt: "",
            summary: "",
          },
        ],
      });
      const dispatch = claimUnreadArticles(db, "legacy:cron", 10);
      expect(dispatch).toBeDefined();
      db.prepare("UPDATE rss_articles SET dispatch_owner_key=NULL").run();
    } finally {
      db.close();
    }

    const reopened = openRssDb(dbPath);
    try {
      expect(
        claimUnreadArticles(reopened, "legacy:cron", 10)?.jobId,
      ).toBeDefined();
      expect(
        reopened.prepare("SELECT dispatch_owner_key FROM rss_articles").get(),
      ).toEqual({
        dispatch_owner_key: "legacy:cron",
      });
    } finally {
      reopened.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
