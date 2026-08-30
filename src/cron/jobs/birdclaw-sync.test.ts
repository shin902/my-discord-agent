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

  it("accepts legacy settings during the configuration rollout", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-test-"));
    tempDirs.push(dir);
    process.env.BIRDCLAW_BIN = path.join(dir, "missing-birdclaw");
    process.env.X_SAVED_DB_PATH = path.join(dir, "x-saved.sqlite");
    process.env.X_SAVED_BACKUP_DIR = path.join(dir, "backups");

    await expect(
      handler({
        settings: {
          mode: "xurl",
          limit: 100,
          maxPages: 3,
          backupKeep: 14,
          backupPath: path.join(dir, "backups"),
        },
      } as CronContext),
    ).rejects.toThrow("outside the live database directory");
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
