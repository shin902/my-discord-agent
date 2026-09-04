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
  ingestXSavedItems,
  markInitialImportCompleted,
  openXSavedDb,
  recordSyncRun,
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

function createLegacyXSavedFixture(
  dbPath: string,
  baselineMode: "historical" | "keep-backlog",
): void {
  const legacy = new Database(dbPath);
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
      note TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE x_tags (tweet_id TEXT NOT NULL, tag TEXT NOT NULL);
    CREATE TABLE x_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO x_items VALUES (
      'legacy', 'old', 'author', 'https://x.com/i/status/legacy', NULL, '[]',
      0, 0, 1, '2026-08-27T00:00:00Z', '2026-08-27T00:00:00Z'
    );
    INSERT INTO x_item_state VALUES (
      'legacy', 'keep', 'preserve', '2026-08-27T00:00:00Z'
    );
    INSERT INTO x_tags VALUES ('legacy', 'saved');
  `);
  legacy
    .prepare("INSERT INTO x_meta VALUES ('baseline_mode', ?)")
    .run(baselineMode);
  if (baselineMode === "historical") {
    legacy
      .prepare("INSERT INTO x_meta VALUES ('baseline_initialized_at', ?)")
      .run("2026-08-28T00:00:00Z");
  }
  legacy.pragma("user_version = 1");
  legacy.close();
}

describe("x-saved persistence", () => {
  it("keeps backups outside the live DB mount", async () => {
    const dir = makeTempDir();
    const targetPath = path.join(dir, "x-saved.sqlite");
    const backupDir = path.join(
      path.dirname(dir),
      `${path.basename(dir)}-host-only-backups`,
    );
    const db = openXSavedDb(targetPath);
    db.close();

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

  it("preserves missing metadata but applies explicitly empty external URLs", () => {
    const dir = makeTempDir();
    const target = openXSavedDb(path.join(dir, "x-saved.sqlite"));

    ingestXSavedItems(
      [
        {
          tweetId: "metadata",
          text: "complete",
          authorHandle: "author",
          tweetCreatedAt: "2026-08-28T00:00:00Z",
          externalUrls: ["https://example.com/article"],
          seenLiked: true,
          seenBookmarked: false,
        },
      ],
      { xSavedDb: target },
    );
    ingestXSavedItems(
      [
        {
          tweetId: "metadata",
          text: "updated",
          seenLiked: false,
          seenBookmarked: true,
        },
      ],
      { xSavedDb: target },
    );

    expect(
      target
        .prepare(
          `SELECT text, author_handle, tweet_created_at,
                  external_urls_json, seen_liked, seen_bookmarked
           FROM x_items WHERE tweet_id = 'metadata'`,
        )
        .get(),
    ).toEqual({
      text: "updated",
      author_handle: "author",
      tweet_created_at: "2026-08-28T00:00:00Z",
      external_urls_json: '["https://example.com/article"]',
      seen_liked: 1,
      seen_bookmarked: 1,
    });

    ingestXSavedItems(
      [
        {
          tweetId: "metadata",
          text: "updated again",
          authorHandle: "new-author",
          externalUrls: [],
          seenLiked: false,
          seenBookmarked: false,
        },
      ],
      { xSavedDb: target },
    );
    expect(
      target
        .prepare(
          `SELECT author_handle, tweet_created_at, external_urls_json
           FROM x_items WHERE tweet_id = 'metadata'`,
        )
        .get(),
    ).toEqual({
      author_handle: "new-author",
      tweet_created_at: "2026-08-28T00:00:00Z",
      external_urls_json: "[]",
    });
    target.close();
  });

  it("reingests the same item without duplicating rows or resetting state", () => {
    const dir = makeTempDir();
    const db = openXSavedDb(path.join(dir, "x-saved.sqlite"));
    const firstSeenAt = "2026-08-28T00:00:00Z";
    const lastSeenAt = "2026-08-29T00:00:00Z";

    expect(
      ingestXSavedItems(
        [
          {
            tweetId: "repeat",
            text: "first text",
            authorHandle: "author",
            seenLiked: true,
            seenBookmarked: false,
          },
        ],
        { xSavedDb: db, now: firstSeenAt },
      ),
    ).toEqual({ newItems: 1 });
    db.prepare(
      `UPDATE x_item_state
       SET status = 'keep', note = ?, updated_at = ?
       WHERE tweet_id = 'repeat'`,
    ).run("remember this", firstSeenAt);

    expect(
      ingestXSavedItems(
        [
          {
            tweetId: "repeat",
            text: "updated text",
            authorHandle: "author",
            seenLiked: false,
            seenBookmarked: true,
          },
        ],
        { xSavedDb: db, now: lastSeenAt },
      ),
    ).toEqual({ newItems: 0 });

    expect(
      db
        .prepare(
          `SELECT i.text, i.seen_liked, i.seen_bookmarked,
                  i.first_seen_at, i.last_seen_at,
                  s.status, s.note
           FROM x_items i
           JOIN x_item_state s ON s.tweet_id = i.tweet_id
           WHERE i.tweet_id = 'repeat'`,
        )
        .get(),
    ).toEqual({
      text: "updated text",
      seen_liked: 1,
      seen_bookmarked: 1,
      first_seen_at: firstSeenAt,
      last_seen_at: lastSeenAt,
      status: "keep",
      note: "remember this",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM x_items").get()).toEqual({
      count: 1,
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM x_item_state").get(),
    ).toEqual({ count: 1 });
    db.close();
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

  it.each([
    ["historical", { value: "2026-08-28T00:00:00Z" }],
    ["keep-backlog", undefined],
  ] as const)("migrates %s baseline intent", (baselineMode, expectedMarker) => {
    const targetPath = path.join(makeTempDir(), "x-saved.sqlite");
    createLegacyXSavedFixture(targetPath, baselineMode);

    const db = openXSavedDb(targetPath);
    expect(
      db
        .prepare(
          "SELECT status, note FROM x_item_state WHERE tweet_id = 'legacy'",
        )
        .get(),
    ).toEqual({ status: "keep", note: "preserve" });
    expect(
      db.prepare("SELECT tag FROM x_tags WHERE tweet_id = 'legacy'").get(),
    ).toEqual({ tag: "saved" });
    expect(
      db
        .prepare(
          "SELECT value FROM x_meta WHERE key = 'initial_import_completed_at'",
        )
        .get(),
    ).toEqual(expectedMarker);
    expect(
      db
        .prepare(
          "SELECT key FROM x_meta WHERE key IN ('baseline_initialized_at', 'baseline_mode')",
        )
        .all(),
    ).toEqual([]);
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
