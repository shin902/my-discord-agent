import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listUnreadArticles, openRssDb, saveFeedEntries } from "./store.js";

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
