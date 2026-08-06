import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { planRssRetention, pruneRssRetention } from "./retention.js";

const at = new Date("2025-01-01T00:00:00.000Z");

function createRssOnlyDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE rss_articles (
      id INTEGER PRIMARY KEY,
      entry_id TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      published_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      read_at TEXT,
      dispatch_id TEXT
    );
  `);
  return db;
}

function insertArticle(db: Database.Database, id: number, readAt: string | null, dispatchId: string | null = null): void {
  db.prepare(`
    INSERT INTO rss_articles
      (id, entry_id, title, link, published_at, summary, collected_at, read_at, dispatch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `entry-${id}`, `Article ${id}`, `https://example.test/${id}`, "2020-01-01T00:00:00.000Z", "summary", "2020-01-01T00:00:00.000Z", readAt, dispatchId);
}

describe("RSS retention", () => {
  it("plans and prunes an old read article in an RSS-only database", async () => {
    const db = createRssOnlyDb();
    const archiveDir = await mkdtemp(join(tmpdir(), "rss-retention-success-"));
    try {
      insertArticle(db, 1, "2020-01-01T00:00:00.000Z");

      const plan = planRssRetention(db, { rssArticlesMs: 1 }, at);
      expect(plan.items.map((item) => item.id)).toEqual(["1"]);

      const result = await pruneRssRetention(db, { rssArticlesMs: 1, archiveDir }, { at });
      expect(result.planned).toBe(1);
      expect(result.archived).toBe(1);
      expect(result.deleted).toBe(1);
      expect(db.prepare("SELECT id FROM rss_articles WHERE id=1").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("protects unread and dispatched articles", async () => {
    const db = createRssOnlyDb();
    const archiveDir = await mkdtemp(join(tmpdir(), "rss-retention-protected-"));
    try {
      insertArticle(db, 1, "2020-01-01T00:00:00.000Z");
      insertArticle(db, 2, null);
      insertArticle(db, 3, "2020-01-01T00:00:00.000Z", "dispatch-3");

      const plan = planRssRetention(db, { rssArticlesMs: 1 }, at);
      expect(plan.items.map((item) => item.id)).toEqual(["1"]);
      expect(plan.protected).toBe(2);

      const result = await pruneRssRetention(db, { rssArticlesMs: 1, archiveDir }, { at });
      expect(result.deleted).toBe(1);
      expect(db.prepare("SELECT id FROM rss_articles WHERE id IN (2, 3) ORDER BY id").all()).toEqual([{ id: 2 }, { id: 3 }]);
    } finally {
      db.close();
    }
  });

  it("does not delete RSS articles when archive creation fails", async () => {
    const db = createRssOnlyDb();
    const directory = await mkdtemp(join(tmpdir(), "rss-retention-failure-"));
    const archiveDir = join(directory, "not-a-directory");
    await writeFile(archiveDir, "block");
    try {
      insertArticle(db, 1, "2020-01-01T00:00:00.000Z");

      await expect(pruneRssRetention(db, { rssArticlesMs: 1, archiveDir }, { at })).rejects.toThrow();
      expect(db.prepare("SELECT id FROM rss_articles WHERE id=1").get()).toEqual({ id: 1 });
    } finally {
      db.close();
    }
  });
});
