import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { runXSavedSync } from "./sync.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

const response = JSON.stringify({
  ok: true,
  source: "xurl",
  payload: {
    data: [
      {
        id: "123456789012345678",
        text: "from HTTP response",
        author_id: "author-1",
        created_at: "2026-09-03T00:00:00.000Z",
        entities: {
          urls: [{ expanded_url: "https://example.com/article" }],
        },
      },
    ],
    includes: {
      users: [{ id: "author-1", username: "author" }],
    },
  },
});

const emptyResponse = JSON.stringify({
  ok: true,
  source: "xurl",
  payload: { data: [] },
});

const completeResponse = JSON.stringify({
  ok: true,
  source: "xurl",
  payload: {
    data: [
      {
        id: "duplicate",
        text: "complete metadata",
        author_id: "author-1",
        created_at: "2026-09-03T00:00:00.000Z",
        entities: { urls: [{ expanded_url: "https://example.com/article" }] },
      },
    ],
    includes: { users: [{ id: "author-1", username: "author" }] },
  },
});

const incompleteResponse = JSON.stringify({
  ok: true,
  source: "xurl",
  payload: {
    data: [{ id: "duplicate", text: "latest text", author_id: "author-1" }],
  },
});

function createBirdclawSourceFixture(
  dbPath: string,
  item?: { id: string; text: string; kind: "likes" | "bookmarks" },
): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, handle TEXT NOT NULL
    );
    CREATE TABLE profiles (id TEXT PRIMARY KEY, handle TEXT NOT NULL);
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
    INSERT INTO accounts VALUES ('acct_primary', 'Test User', 'tester');
    INSERT INTO profiles VALUES ('profile_a', 'db_author');
  `);
  if (item) {
    db.prepare(
      `INSERT INTO tweets (
        id, account_id, author_profile_id, text, created_at, entities_json
      ) VALUES (?, 'acct_primary', 'profile_a', ?, ?, '{}')`,
    ).run(item.id, item.text, "2026-09-03T00:00:00.000Z");
    db.prepare(
      `INSERT INTO tweet_collections (account_id, tweet_id, kind)
       VALUES ('acct_primary', ?, ?)`,
    ).run(item.id, item.kind);
  }
  db.close();
}

function writeBirdclawScript(
  binary: string,
  responses: { bookmarks: string; likes: string },
): void {
  writeFileSync(
    binary,
    `#!/bin/sh
case "$2" in
  bookmarks) printf '%s\\n' '${responses.bookmarks}' ;;
  likes) printf '%s\\n' '${responses.likes}' ;;
esac
`,
  );
  chmodSync(binary, 0o755);
}

afterEach(() => {
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("x-saved sync", () => {
  it("complements an empty HTTP response with BirdClaw database items", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "x-saved-sync-test-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "birdclaw");
    const birdclawDbPath = path.join(dir, "birdclaw.sqlite");
    const xSavedDbPath = path.join(dir, "x-saved", "x-saved.sqlite");
    createBirdclawSourceFixture(birdclawDbPath, {
      id: "from-db",
      text: "from BirdClaw database",
      kind: "bookmarks",
    });
    writeBirdclawScript(binary, {
      bookmarks: emptyResponse,
      likes: emptyResponse,
    });
    process.env.BIRDCLAW_BIN = binary;

    const result = await runXSavedSync({
      birdclawDbPath,
      xSavedDbPath,
      backupPath: path.join(dir, "backups"),
    });

    expect(result.status).toBe("success");
    expect(result.newItems).toBe(1);
    const db = new Database(xSavedDbPath, { readonly: true });
    expect(db.prepare("SELECT tweet_id, text FROM x_items").all()).toEqual([
      { tweet_id: "from-db", text: "from BirdClaw database" },
    ]);
    db.close();
  });

  it("complements a partial HTTP sync with BirdClaw database items", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "x-saved-sync-test-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "birdclaw");
    const birdclawDbPath = path.join(dir, "birdclaw.sqlite");
    const xSavedDbPath = path.join(dir, "x-saved", "x-saved.sqlite");
    createBirdclawSourceFixture(birdclawDbPath, {
      id: "from-db",
      text: "from failed collection's local database",
      kind: "likes",
    });
    writeFileSync(
      binary,
      `#!/bin/sh
case "$2" in
  bookmarks) printf '%s\\n' '${emptyResponse}' ;;
  likes) exit 1 ;;
esac
`,
    );
    chmodSync(binary, 0o755);
    process.env.BIRDCLAW_BIN = binary;

    const result = await runXSavedSync({
      birdclawDbPath,
      xSavedDbPath,
      backupPath: path.join(dir, "backups"),
    });

    expect(result.status).toBe("partial");
    expect(result.errors).toHaveLength(1);
    expect(result.newItems).toBe(1);
    const db = new Database(xSavedDbPath, { readonly: true });
    expect(db.prepare("SELECT tweet_id FROM x_items").all()).toEqual([
      { tweet_id: "from-db" },
    ]);
    db.close();
  });

  it("preserves metadata missing from a later duplicate response", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "x-saved-sync-test-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "birdclaw");
    const xSavedDbPath = path.join(dir, "x-saved", "x-saved.sqlite");
    writeBirdclawScript(binary, {
      bookmarks: completeResponse,
      likes: incompleteResponse,
    });
    process.env.BIRDCLAW_BIN = binary;
    process.env.BIRDCLAW_DB_PATH = path.join(dir, "empty-birdclaw.sqlite");
    createBirdclawSourceFixture(process.env.BIRDCLAW_DB_PATH);

    const result = await runXSavedSync({
      xSavedDbPath,
      backupPath: path.join(dir, "backups"),
    });

    expect(result.status).toBe("success");
    expect(result.newItems).toBe(1);
    const db = new Database(xSavedDbPath, { readonly: true });
    expect(
      db
        .prepare(
          `SELECT text, author_handle, tweet_created_at,
                  external_urls_json, seen_liked, seen_bookmarked
           FROM x_items WHERE tweet_id = 'duplicate'`,
        )
        .get(),
    ).toEqual({
      text: "latest text",
      author_handle: "author",
      tweet_created_at: "2026-09-03T00:00:00.000Z",
      external_urls_json: '["https://example.com/article"]',
      seen_liked: 1,
      seen_bookmarked: 1,
    });
    db.close();
  });

  it("ingests tweet metadata from successful BirdClaw HTTP responses", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "x-saved-sync-test-"));
    tempDirs.push(dir);
    const binary = path.join(dir, "birdclaw");
    const xSavedDbPath = path.join(dir, "x-saved", "x-saved.sqlite");
    const backupPath = path.join(dir, "backups");
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' '${response}'
`,
    );
    chmodSync(binary, 0o755);
    process.env.BIRDCLAW_BIN = binary;
    process.env.BIRDCLAW_DB_PATH = path.join(dir, "missing-birdclaw.sqlite");

    const result = await runXSavedSync({
      mode: "xurl",
      limit: 100,
      maxPages: 3,
      xSavedDbPath,
      backupPath,
    });

    expect(result.status).toBe("success");
    expect(result.newItems).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.backupPath).toContain(path.join("backups", "x-saved-"));
    expect(readFileSync(result.backupPath as string).length).toBeGreaterThan(0);

    const db = new Database(xSavedDbPath, { readonly: true });
    expect(
      db
        .prepare(
          `SELECT tweet_id, text, author_handle, url, tweet_created_at,
                  external_urls_json, seen_liked, seen_bookmarked
           FROM x_items`,
        )
        .get(),
    ).toEqual({
      tweet_id: "123456789012345678",
      text: "from HTTP response",
      author_handle: "author",
      url: "https://x.com/author/status/123456789012345678",
      tweet_created_at: "2026-09-03T00:00:00.000Z",
      external_urls_json: '["https://example.com/article"]',
      seen_liked: 1,
      seen_bookmarked: 1,
    });
    db.close();
  });
});
