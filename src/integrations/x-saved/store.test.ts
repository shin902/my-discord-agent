import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  ingestBirdclawSavedItems,
  initializeHistoricalBaseline,
  openXSavedDb,
  recordSyncRun,
} from "./store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x-saved-test-"));
  tempDirs.push(dir);
  return dir;
}

function createBirdclawFixture(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      handle TEXT NOT NULL
    );
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL
    );
    CREATE TABLE tweets (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      author_profile_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT,
      liked INTEGER NOT NULL DEFAULT 0,
      bookmarked INTEGER NOT NULL DEFAULT 0,
      entities_json TEXT NOT NULL DEFAULT '{}',
      deleted_at TEXT,
      superseded_at TEXT
    );
    CREATE TABLE tweet_collections (
      account_id TEXT NOT NULL,
      tweet_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      collected_at TEXT,
      source TEXT NOT NULL DEFAULT 'test',
      raw_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL DEFAULT '2026-08-28T00:00:00Z',
      PRIMARY KEY (account_id, tweet_id, kind)
    );
  `);
  db.prepare("INSERT INTO accounts (id, name, handle) VALUES (?, ?, ?)").run(
    "acct_primary",
    "Test User",
    "tester",
  );
  db.prepare("INSERT INTO profiles (id, handle) VALUES (?, ?)").run(
    "profile_a",
    "author_a",
  );
  db.prepare("INSERT INTO profiles (id, handle) VALUES (?, ?)").run(
    "profile_b",
    "author_b",
  );
  return db;
}

describe("x-saved BirdClaw ingest", () => {
  it("imports likes/bookmarks while preserving sticky source history and agent state", () => {
    const dir = makeTempDir();
    const sourcePath = path.join(dir, "birdclaw.sqlite");
    const targetPath = path.join(dir, "x-saved.sqlite");
    const source = createBirdclawFixture(sourcePath);

    source
      .prepare(
        `INSERT INTO tweets (
          id, account_id, author_profile_id, text, created_at,
          liked, bookmarked, entities_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "100",
        "acct_primary",
        "profile_a",
        "first text",
        "2026-08-20T00:00:00Z",
        1,
        0,
        JSON.stringify({
          urls: [{ expandedUrl: "https://example.com/article" }],
        }),
      );
    source
      .prepare(
        `INSERT INTO tweets (
          id, account_id, author_profile_id, text, created_at,
          liked, bookmarked, entities_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "200",
        "acct_primary",
        "profile_b",
        "second text",
        "2026-08-21T00:00:00Z",
        0,
        0,
        "{}",
      );
    source
      .prepare(
        `INSERT INTO tweet_collections (
          account_id, tweet_id, kind, collected_at
        ) VALUES (?, ?, ?, ?)`,
      )
      .run("acct_primary", "200", "bookmarks", "2026-08-22T00:00:00Z");
    source.close();

    const first = ingestBirdclawSavedItems({
      birdclawDbPath: sourcePath,
      xSavedDbPath: targetPath,
      account: "tester",
      now: "2026-08-28T00:00:00Z",
    });
    expect(first).toEqual({ sourceItems: 2, newItems: 2, updatedItems: 0 });

    const target = openXSavedDb(targetPath);
    const item100 = target
      .prepare(
        `SELECT text, author_handle, seen_liked, seen_bookmarked,
                external_urls_json, baseline
         FROM x_items WHERE tweet_id = '100'`,
      )
      .get() as {
      text: string;
      author_handle: string;
      seen_liked: number;
      seen_bookmarked: number;
      external_urls_json: string;
      baseline: number;
    };
    expect(item100.text).toBe("first text");
    expect(item100.author_handle).toBe("author_a");
    expect(item100.seen_liked).toBe(1);
    expect(item100.seen_bookmarked).toBe(0);
    expect(JSON.parse(item100.external_urls_json)).toEqual([
      "https://example.com/article",
    ]);
    expect(item100.baseline).toBe(0);

    target
      .prepare(
        `UPDATE x_item_state
         SET status = 'try', priority = 90, summary = 'test it',
             note = 'keep this note', updated_at = ?
         WHERE tweet_id = '100'`,
      )
      .run("2026-08-28T00:05:00Z");
    target.close();

    const sourceAgain = new Database(sourcePath);
    sourceAgain
      .prepare(
        `UPDATE tweets
         SET text = ?, liked = 0, bookmarked = 1
         WHERE id = '100'`,
      )
      .run("updated text");
    sourceAgain.close();

    const second = ingestBirdclawSavedItems({
      birdclawDbPath: sourcePath,
      xSavedDbPath: targetPath,
      account: "@tester",
      now: "2026-08-29T00:00:00Z",
    });
    expect(second).toEqual({ sourceItems: 2, newItems: 0, updatedItems: 2 });

    const verify = openXSavedDb(targetPath);
    const sticky = verify
      .prepare(
        `SELECT i.text, i.seen_liked, i.seen_bookmarked,
                s.status, s.priority, s.summary, s.note
         FROM x_items i
         JOIN x_item_state s ON s.tweet_id = i.tweet_id
         WHERE i.tweet_id = '100'`,
      )
      .get() as {
      text: string;
      seen_liked: number;
      seen_bookmarked: number;
      status: string;
      priority: number;
      summary: string;
      note: string;
    };
    expect(sticky).toEqual({
      text: "updated text",
      seen_liked: 1,
      seen_bookmarked: 1,
      status: "try",
      priority: 90,
      summary: "test it",
      note: "keep this note",
    });
    verify.close();
  });

  it("marks the initial archive as a one-time historical baseline", () => {
    const dir = makeTempDir();
    const targetPath = path.join(dir, "x-saved.sqlite");
    const db = openXSavedDb(targetPath);
    db.prepare(
      `INSERT INTO x_items (
        tweet_id, text, author_handle, url, seen_liked, seen_bookmarked,
        baseline, first_seen_at, last_seen_at
      ) VALUES ('1', 'a', 'author', 'https://x.com/author/status/1', 1, 0, 0, ?, ?)`,
    ).run("2026-08-28T00:00:00Z", "2026-08-28T00:00:00Z");
    db.prepare(
      `INSERT INTO x_item_state (tweet_id, status, updated_at)
       VALUES ('1', 'inbox', ?)`,
    ).run("2026-08-28T00:00:00Z");

    expect(initializeHistoricalBaseline(db, "2026-08-28T00:01:00Z")).toEqual({
      applied: true,
      count: 1,
    });
    expect(initializeHistoricalBaseline(db, "2026-08-29T00:01:00Z")).toEqual({
      applied: false,
      count: 0,
    });
    const row = db
      .prepare("SELECT baseline FROM x_items WHERE tweet_id = '1'")
      .get() as { baseline: number };
    expect(row.baseline).toBe(1);
    db.close();
  });

  it("records sync health separately from item state", () => {
    const dir = makeTempDir();
    const targetPath = path.join(dir, "x-saved.sqlite");
    const db = openXSavedDb(targetPath);
    const id = recordSyncRun(db, {
      startedAt: "2026-08-28T04:00:00Z",
      completedAt: "2026-08-28T04:00:10Z",
      status: "partial",
      bookmarksFetched: 12,
      likesFetched: null,
      newItems: 3,
      updatedItems: 20,
      error: "likes: rate limited",
      details: { likes: { ok: false } },
    });
    expect(id).toBe(1);
    const row = db
      .prepare(
        `SELECT status, bookmarks_fetched, likes_fetched,
                new_items, updated_items, error, details_json
         FROM x_sync_runs WHERE id = ?`,
      )
      .get(id) as {
      status: string;
      bookmarks_fetched: number;
      likes_fetched: null;
      new_items: number;
      updated_items: number;
      error: string;
      details_json: string;
    };
    expect(row.status).toBe("partial");
    expect(row.bookmarks_fetched).toBe(12);
    expect(row.likes_fetched).toBeNull();
    expect(row.new_items).toBe(3);
    expect(row.updated_items).toBe(20);
    expect(row.error).toBe("likes: rate limited");
    expect(JSON.parse(row.details_json)).toEqual({ likes: { ok: false } });
    db.close();
  });
});
