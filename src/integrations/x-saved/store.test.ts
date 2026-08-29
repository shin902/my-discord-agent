import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  backupXSavedDatabase,
  ingestBirdclawSavedItems,
  markInitialImportCompleted,
  openXSavedDb,
  recordSyncRun,
  resolveBirdclawDbPath,
  resolveXSavedBackupDir,
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
  it("normalizes BirdClaw home paths and keeps backups outside the live DB mount", async () => {
    const dir = makeTempDir();
    const targetPath = path.join(dir, "x-saved.sqlite");
    const backupDir = path.join(
      path.dirname(dir),
      `${path.basename(dir)}-host-only-backups`,
    );
    const db = openXSavedDb(targetPath);
    db.close();

    expect(resolveBirdclawDbPath("~/birdclaw.sqlite")).toBe(
      path.join(os.homedir(), "birdclaw.sqlite"),
    );
    expect(resolveXSavedBackupDir()).toContain(
      path.join("data", "x-saved-backups"),
    );
    await expect(
      backupXSavedDatabase(targetPath, 1, path.join(dir, "backups")),
    ).rejects.toThrow("outside the live database directory");
    const backupPath = await backupXSavedDatabase(targetPath, 1, backupDir);
    expect(backupPath).toBe(path.join(backupDir, path.basename(backupPath)));
  });

  it("retains only x-saved backups in a shared directory", async () => {
    const dir = makeTempDir();
    const liveDir = path.join(dir, "live");
    const targetPath = path.join(liveDir, "x-saved.sqlite");
    const backupDir = path.join(dir, "shared-backups");
    mkdirSync(liveDir);
    mkdirSync(backupDir);
    writeFileSync(path.join(backupDir, "unrelated.sqlite"), "do not delete");
    writeFileSync(
      path.join(backupDir, "2020-01-01T00-00-00-000Z.sqlite"),
      "legacy old",
    );
    writeFileSync(
      path.join(backupDir, "2020-01-01T00-00-00.sqlite"),
      "invalid legacy name",
    );
    const db = openXSavedDb(targetPath);
    db.close();

    const backupPath = await backupXSavedDatabase(targetPath, 1, backupDir);

    expect(path.basename(backupPath)).toMatch(/^x-saved-.*\.sqlite$/);
    expect(existsSync(path.join(backupDir, "unrelated.sqlite"))).toBe(true);
    expect(
      existsSync(path.join(backupDir, "2020-01-01T00-00-00-000Z.sqlite")),
    ).toBe(false);
    expect(existsSync(path.join(backupDir, "2020-01-01T00-00-00.sqlite"))).toBe(
      true,
    );
  });

  it("rejects backup paths under the lexical DB directory when the DB is a symlink", async () => {
    const dir = makeTempDir();
    const hostDir = path.join(dir, "host-data");
    const agentDir = path.join(dir, "agent-data");
    const targetPath = path.join(hostDir, "x-saved.sqlite");
    const mountedDbPath = path.join(agentDir, "x-saved.sqlite");
    mkdirSync(hostDir);
    mkdirSync(agentDir);
    const db = openXSavedDb(targetPath);
    db.close();
    symlinkSync(targetPath, mountedDbPath);

    await expect(
      backupXSavedDatabase(mountedDbPath, 1, path.join(agentDir, "backups")),
    ).rejects.toThrow("outside the live database directory");
  });

  it("rejects backups under symlinked configured and target DB directories", async () => {
    const dir = makeTempDir();
    const configuredDir = path.join(dir, "configured-data");
    const configuredAlias = path.join(dir, "configured-alias");
    const mountedDir = path.join(dir, "mounted-data");
    const targetDir = path.join(dir, "host-data");
    const configuredDbPath = path.join(configuredDir, "x-saved.sqlite");
    const mountedDbPath = path.join(mountedDir, "x-saved.sqlite");
    const targetPath = path.join(targetDir, "x-saved.sqlite");
    mkdirSync(mountedDir);
    mkdirSync(targetDir);
    symlinkSync(mountedDir, configuredDir, "dir");
    symlinkSync(mountedDir, configuredAlias, "dir");
    const db = openXSavedDb(targetPath);
    db.close();
    symlinkSync(targetPath, mountedDbPath);

    await expect(
      backupXSavedDatabase(
        configuredDbPath,
        1,
        path.join(configuredDir, "backups"),
      ),
    ).rejects.toThrow("outside the live database directory");
    await expect(
      backupXSavedDatabase(
        configuredDbPath,
        1,
        path.join(configuredAlias, "backups"),
      ),
    ).rejects.toThrow("outside the live database directory");
  });

  it("rejects symlinked backup paths inside the live database directory", async () => {
    const dir = makeTempDir();
    const liveDir = path.join(dir, "live");
    const liveAlias = path.join(dir, "live-alias");
    const backupAlias = path.join(dir, "backup-alias");
    mkdirSync(liveDir);
    symlinkSync(liveDir, liveAlias, "dir");
    symlinkSync(liveDir, backupAlias, "dir");
    const targetPath = path.join(liveAlias, "x-saved.sqlite");
    const db = openXSavedDb(targetPath);
    db.close();

    await expect(
      backupXSavedDatabase(
        targetPath,
        1,
        path.join(backupAlias, "new-backup-directory"),
      ),
    ).rejects.toThrow("outside the live database directory");
  });

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
    expect(first).toEqual({ newItems: 2 });

    const target = openXSavedDb(targetPath);
    const item100 = target
      .prepare(
        `SELECT text, author_handle, seen_liked, seen_bookmarked,
                external_urls_json
         FROM x_items WHERE tweet_id = '100'`,
      )
      .get() as {
      text: string;
      author_handle: string;
      seen_liked: number;
      seen_bookmarked: number;
      external_urls_json: string;
    };
    expect(item100.text).toBe("first text");
    expect(item100.author_handle).toBe("author_a");
    expect(item100.seen_liked).toBe(1);
    expect(item100.seen_bookmarked).toBe(0);
    expect(JSON.parse(item100.external_urls_json)).toEqual([
      "https://example.com/article",
    ]);
    target
      .prepare(
        `UPDATE x_item_state
         SET status = 'try', note = ?, updated_at = ?
         WHERE tweet_id = '100'`,
      )
      .run("keep this note", "2026-08-28T00:05:00Z");
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
    expect(second).toEqual({ newItems: 0 });

    const verify = openXSavedDb(targetPath);
    const sticky = verify
      .prepare(
        `SELECT i.text, i.seen_liked, i.seen_bookmarked,
                s.status, s.note
         FROM x_items i
         JOIN x_item_state s ON s.tweet_id = i.tweet_id
         WHERE i.tweet_id = '100'`,
      )
      .get() as {
      text: string;
      seen_liked: number;
      seen_bookmarked: number;
      status: string;
      note: string;
    };
    expect(sticky).toEqual({
      text: "updated text",
      seen_liked: 1,
      seen_bookmarked: 1,
      status: "try",
      note: "keep this note",
    });
    verify.close();
  });

  it("records the initial import completion only once", () => {
    const dir = makeTempDir();
    const targetPath = path.join(dir, "x-saved.sqlite");
    const db = openXSavedDb(targetPath);

    expect(markInitialImportCompleted(db, "2026-08-28T00:01:00Z")).toBe(true);
    expect(markInitialImportCompleted(db, "2026-08-29T00:01:00Z")).toBe(false);
    const row = db
      .prepare(
        "SELECT value FROM x_meta WHERE key = 'initial_import_completed_at'",
      )
      .get() as { value: string };
    expect(row.value).toBe("2026-08-28T00:01:00Z");
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('x_items') WHERE name = 'baseline'",
        )
        .get(),
    ).toBeUndefined();
    db.close();
  });

  it("uses the initial import time to select only newer pending items", () => {
    const dir = makeTempDir();
    const targetPath = path.join(dir, "x-saved.sqlite");
    const db = openXSavedDb(targetPath);
    const insertItem = db.prepare(`
      INSERT INTO x_items (
        tweet_id, text, author_handle, url, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertState = db.prepare(
      "INSERT INTO x_item_state (tweet_id, status, updated_at) VALUES (?, 'inbox', ?)",
    );
    insertItem.run(
      "old",
      "old item",
      "author",
      "https://x.com/i/status/old",
      "2026-08-28T00:00:00Z",
      "2026-08-28T00:00:00Z",
    );
    insertState.run("old", "2026-08-28T00:00:00Z");
    insertItem.run(
      "new",
      "new item",
      "author",
      "https://x.com/i/status/new",
      "2026-08-28T00:02:00Z",
      "2026-08-28T00:02:00Z",
    );
    insertState.run("new", "2026-08-28T00:02:00Z");
    markInitialImportCompleted(db, "2026-08-28T00:01:00Z");

    const pendingQuery = db.prepare(`
      SELECT i.tweet_id
      FROM x_items i
      JOIN x_item_state s ON s.tweet_id = i.tweet_id
      LEFT JOIN x_meta initial_import
        ON initial_import.key = 'initial_import_completed_at'
      WHERE s.status = 'inbox'
        AND (
          initial_import.value IS NULL
          OR i.first_seen_at > initial_import.value
        )
      ORDER BY i.first_seen_at ASC
    `);
    const pending = () => pendingQuery.all() as Array<{ tweet_id: string }>;

    expect(pending()).toEqual([{ tweet_id: "new" }]);

    db.prepare(
      "DELETE FROM x_meta WHERE key = 'initial_import_completed_at'",
    ).run();
    expect(pending()).toEqual([{ tweet_id: "old" }, { tweet_id: "new" }]);
    db.close();
  });

  it("migrates the old management schema to the compact schema", () => {
    const dir = makeTempDir();
    const targetPath = path.join(dir, "x-saved.sqlite");
    const legacy = new Database(targetPath);
    legacy.exec(`
      CREATE TABLE x_items (
        tweet_id TEXT PRIMARY KEY, text TEXT NOT NULL,
        author_handle TEXT NOT NULL DEFAULT '', url TEXT NOT NULL,
        tweet_created_at TEXT, external_urls_json TEXT NOT NULL DEFAULT '[]',
        seen_liked INTEGER NOT NULL DEFAULT 0,
        seen_bookmarked INTEGER NOT NULL DEFAULT 0,
        baseline INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE x_item_state (
        tweet_id TEXT PRIMARY KEY, status TEXT NOT NULL,
        priority INTEGER, summary TEXT, note TEXT, processed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE x_tags (tweet_id TEXT NOT NULL, tag TEXT NOT NULL);
      CREATE TABLE x_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL, status TEXT NOT NULL,
        bookmarks_fetched INTEGER, likes_fetched INTEGER,
        new_items INTEGER NOT NULL DEFAULT 0,
        updated_items INTEGER NOT NULL DEFAULT 0, error TEXT,
        details_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE x_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX idx_x_items_baseline ON x_items(baseline, first_seen_at DESC);
      INSERT INTO x_items (
        tweet_id, text, author_handle, url, baseline, first_seen_at, last_seen_at
      ) VALUES ('legacy', 'old', 'author', 'https://x.com/i/status/legacy', 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z');
      INSERT INTO x_item_state (tweet_id, status, note, updated_at)
      VALUES ('legacy', 'keep', 'preserve', '2026-08-27T00:00:00Z');
      INSERT INTO x_meta (key, value)
      VALUES ('baseline_initialized_at', '2026-08-28T00:00:00Z');
    `);
    legacy
      .prepare(
        "INSERT INTO x_sync_runs (started_at, completed_at, status, new_items) VALUES (?, ?, ?, ?)",
      )
      .run("2026-08-28T00:00:00Z", "2026-08-28T00:00:01Z", "success", 1);
    legacy.pragma("user_version = 1");
    legacy.close();

    const db = openXSavedDb(targetPath);
    const item = db
      .prepare(
        "SELECT status, note FROM x_item_state WHERE tweet_id = 'legacy'",
      )
      .get();
    expect(item).toEqual({ status: "keep", note: "preserve" });
    expect(
      db
        .prepare(
          "SELECT value FROM x_meta WHERE key = 'initial_import_completed_at'",
        )
        .get(),
    ).toEqual({ value: "2026-08-28T00:00:00Z" });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'x_tags'").get(),
    ).toBeUndefined();
    expect(db.pragma("user_version", { simple: true })).toBe(2);
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
      newItems: 3,
      error: "likes: rate limited",
    });
    expect(id).toBe(1);
    const row = db
      .prepare(
        `SELECT status, new_items, error
         FROM x_sync_runs WHERE id = ?`,
      )
      .get(id) as {
      status: string;
      new_items: number;
      error: string;
    };
    expect(row.status).toBe("partial");
    expect(row.new_items).toBe(3);
    expect(row.error).toBe("likes: rate limited");
    expect(
      db
        .prepare(
          "SELECT name FROM pragma_table_info('x_sync_runs') WHERE name LIKE '%fetched%' OR name IN ('details_json', 'updated_items')",
        )
        .all(),
    ).toEqual([]);
    db.close();
  });
});
