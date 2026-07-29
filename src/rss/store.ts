import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { RssEntry } from "./feed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const DEFAULT_DB_PATH = path.join(ROOT, "data/rss.sqlite3");

export interface FeedState {
  id: number;
  url: string;
  etag: string | null;
  lastModified: string | null;
}

export interface UnreadArticle {
  id: number;
  feedName: string;
  feedUrl: string;
  title: string;
  link: string;
  publishedAt: string;
  summary: string;
}

interface FeedRow {
  id: number;
  url: string;
  etag: string | null;
  last_modified: string | null;
}

interface ArticleRow {
  id: number;
  feed_name: string;
  feed_url: string;
  title: string;
  link: string;
  published_at: string;
  summary: string;
}

export function resolveRssDbPath(configuredPath?: string): string {
  if (!configuredPath) return DEFAULT_DB_PATH;
  return path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(ROOT, configuredPath);
}

export function openRssDb(configuredPath?: string): Database.Database {
  const dbPath = resolveRssDbPath(configuredPath);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS rss_feeds (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      name TEXT,
      etag TEXT,
      last_modified TEXT,
      initialized_at TEXT NOT NULL,
      last_fetched_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rss_articles (
      id INTEGER PRIMARY KEY,
      feed_id INTEGER NOT NULL REFERENCES rss_feeds(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      published_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      collected_at TEXT NOT NULL,
      read_at TEXT,
      UNIQUE(feed_id, entry_id)
    );
    CREATE INDEX IF NOT EXISTS rss_articles_unread
      ON rss_articles(read_at, id);
  `);
  return db;
}

export function getFeedState(
  db: Database.Database,
  url: string,
): FeedState | undefined {
  const row = db
    .prepare("SELECT id, url, etag, last_modified FROM rss_feeds WHERE url = ?")
    .get(url) as FeedRow | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    url: row.url,
    etag: row.etag,
    lastModified: row.last_modified,
  };
}

export function touchFeed(
  db: Database.Database,
  feedId: number,
  configuredName?: string,
): void {
  db.prepare(`
    UPDATE rss_feeds
    SET name = COALESCE(?, name), last_fetched_at = ?
    WHERE id = ?
  `).run(configuredName ?? null, new Date().toISOString(), feedId);
}

export function saveFeedEntries(
  db: Database.Database,
  input: {
    url: string;
    configuredName?: string;
    parsedName: string;
    etag: string | null;
    lastModified: string | null;
    entries: RssEntry[];
    markInitialAsRead: boolean;
  },
): number {
  const fetchedAt = new Date().toISOString();

  return db.transaction(() => {
    const existing = getFeedState(db, input.url);
    db.prepare(`
      INSERT INTO rss_feeds
        (url, name, etag, last_modified, initialized_at, last_fetched_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET
        name = excluded.name,
        etag = excluded.etag,
        last_modified = excluded.last_modified,
        last_fetched_at = excluded.last_fetched_at
    `).run(
      input.url,
      (input.configuredName ?? input.parsedName) || null,
      input.etag,
      input.lastModified,
      fetchedAt,
      fetchedAt,
    );

    const feed = getFeedState(db, input.url);
    if (!feed) {
      throw new Error(`RSSフィードを保存できませんでした: ${input.url}`);
    }

    const initialReadAt =
      !existing && input.markInitialAsRead ? fetchedAt : null;
    const insert = db.prepare(`
      INSERT INTO rss_articles
        (feed_id, entry_id, title, link, published_at, summary, collected_at, read_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(feed_id, entry_id) DO NOTHING
    `);
    const update = db.prepare(`
      UPDATE rss_articles
      SET title = ?, link = ?, published_at = ?, summary = ?
      WHERE feed_id = ? AND entry_id = ?
    `);

    let inserted = 0;
    for (const entry of input.entries) {
      const result = insert.run(
        feed.id,
        entry.entryId,
        entry.title,
        entry.link,
        entry.publishedAt,
        entry.summary,
        fetchedAt,
        initialReadAt,
      );
      if (result.changes > 0) {
        inserted++;
      } else {
        update.run(
          entry.title,
          entry.link,
          entry.publishedAt,
          entry.summary,
          feed.id,
          entry.entryId,
        );
      }
    }

    return inserted;
  })();
}

export function listUnreadArticles(
  db: Database.Database,
  limit: number,
  feedUrls?: readonly string[],
): UnreadArticle[] {
  if (feedUrls?.length === 0) return [];
  const feedFilter = feedUrls
    ? `AND f.url IN (${feedUrls.map(() => "?").join(", ")})`
    : "";
  const rows = db
    .prepare(`
      SELECT
        a.id,
        COALESCE(f.name, f.url) AS feed_name,
        f.url AS feed_url,
        a.title,
        a.link,
        a.published_at,
        a.summary
      FROM rss_articles a
      JOIN rss_feeds f ON f.id = a.feed_id
      WHERE a.read_at IS NULL
      ${feedFilter}
      ORDER BY a.id ASC
      LIMIT ?
    `)
    .all(...(feedUrls ?? []), limit) as ArticleRow[];
  return rows.map((row) => ({
    id: row.id,
    feedName: row.feed_name,
    feedUrl: row.feed_url,
    title: row.title,
    link: row.link,
    publishedAt: row.published_at,
    summary: row.summary,
  }));
}

export function markArticlesRead(
  db: Database.Database,
  articleIds: number[],
): void {
  if (articleIds.length === 0) return;
  const placeholders = articleIds.map(() => "?").join(", ");
  db.prepare(`
    UPDATE rss_articles
    SET read_at = ?
    WHERE read_at IS NULL AND id IN (${placeholders})
  `).run(new Date().toISOString(), ...articleIds);
}
