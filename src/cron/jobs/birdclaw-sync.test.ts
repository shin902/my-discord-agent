import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";
import handler from "./birdclaw-sync.js";

const tempDirs: string[] = [];
const originalBirdclawBin = process.env.BIRDCLAW_BIN;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBirdclawBin === undefined) delete process.env.BIRDCLAW_BIN;
  else process.env.BIRDCLAW_BIN = originalBirdclawBin;
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

  it("propagates local database failures into the scheduler retry loop", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-test-"));
    tempDirs.push(dir);
    process.env.BIRDCLAW_BIN = path.join(dir, "missing-birdclaw");

    await expect(
      handler({
        settings: {
          xSavedDbPath: path.join(dir, "x-saved.sqlite"),
          backupPath: path.join(dir, "backups"),
        },
      } as CronContext),
    ).rejects.toThrow("outside the live database directory");
  });

  it("records operational failure without throwing into the generic retry loop", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "birdclaw-sync-test-"));
    tempDirs.push(dir);
    const xSavedDbPath = path.join(dir, "x-saved.sqlite");
    process.env.BIRDCLAW_BIN = path.join(dir, "missing-birdclaw");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const ctx = {
      settings: {
        birdclawDbPath: path.join(dir, "missing-birdclaw.sqlite"),
        xSavedDbPath,
        backupKeep: 1,
      },
    } as CronContext;

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
