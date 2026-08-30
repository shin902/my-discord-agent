import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";
import handler from "./birdclaw-sync.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

function createBirdclawSourceFixture(dbPath: string): void {
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
  db.close();
}

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...originalEnv };
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("birdclaw-sync cron", () => {
  it("rejects unknown settings instead of silently ignoring them", async () => {
    await expect(
      handler({ settings: { maxPage: 1 } } as CronContext),
    ).rejects.toBeInstanceOf(NonRetryableError);
  });

  it("accepts legacy settings and reaches both database overrides", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-test-"));
    tempDirs.push(dir);
    const birdclawDbPath = path.join(dir, "birdclaw.sqlite");
    const xSavedDbPath = path.join(dir, "override", "x-saved.sqlite");
    createBirdclawSourceFixture(birdclawDbPath);
    process.env.BIRDCLAW_BIN = path.join(dir, "missing-birdclaw");
    process.env.BIRDCLAW_DB_PATH = path.join(dir, "env-birdclaw.sqlite");
    process.env.X_SAVED_DB_PATH = path.join(dir, "env", "x-saved.sqlite");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      handler({
        settings: {
          mode: "xurl",
          limit: 100,
          maxPages: 3,
          birdclawDbPath,
          xSavedDbPath,
          backupKeep: 14,
          backupPath: path.join(dir, "backups"),
        },
      } as CronContext),
    ).resolves.toBeUndefined();

    const db = new Database(xSavedDbPath, { readonly: true });
    const row = db
      .prepare("SELECT status, error FROM x_sync_runs ORDER BY id DESC LIMIT 1")
      .get() as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).not.toContain("ingest:");
    db.close();
  });

  it("propagates local database failures into the scheduler retry loop", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-test-"));
    tempDirs.push(dir);
    process.env.BIRDCLAW_BIN = path.join(dir, "missing-birdclaw");
    process.env.X_SAVED_DB_PATH = path.join(dir, "x-saved.sqlite");
    process.env.X_SAVED_BACKUP_DIR = path.join(dir, "backups");

    await expect(handler({ settings: {} } as CronContext)).rejects.toThrow(
      "outside the live database directory",
    );
  });

  it("records operational failure without throwing into the generic retry loop", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-test-"));
    tempDirs.push(dir);
    const xSavedDbPath = path.join(dir, "x-saved.sqlite");
    process.env.BIRDCLAW_BIN = path.join(dir, "missing-birdclaw");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    process.env.BIRDCLAW_DB_PATH = path.join(dir, "missing-birdclaw.sqlite");
    process.env.X_SAVED_DB_PATH = xSavedDbPath;
    const ctx = { settings: {} } as CronContext;

    await expect(handler(ctx)).resolves.toBeUndefined();

    const db = new Database(xSavedDbPath, { readonly: true });
    const row = db
      .prepare("SELECT status, error FROM x_sync_runs ORDER BY id DESC LIMIT 1")
      .get() as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("ingest:");
    db.close();
  });
});
