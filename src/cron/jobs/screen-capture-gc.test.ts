import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import type { CronContext } from "../runner.js";
import handler from "./screen-capture-gc.js";

const now = new Date("2026-09-15T12:00:00.000Z");
const ctx = {
  id: "screen-capture-gc",
  schedule: "0 */6 * * *",
  enabled: true,
  handler: "jobs/screen-capture-gc.ts",
} as CronContext;

describe("screen capture GC cron", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "screen-capture-gc-"));
    vi.stubEnv(
      "SCREEN_CAPTURE_DB_PATH",
      path.join(directory, "captures.sqlite"),
    );
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it("deletes completed captures older than 24 hours only", async () => {
    const db = openScreenCaptureDb();
    const insert = db.prepare(`INSERT INTO screen_captures
      (id, image, received_at, completed_at, accepted) VALUES (?, ?, ?, ?, ?)`);
    const rows = [
      { completedAt: "2026-09-14T11:59:59.999Z", accepted: 1 },
      { completedAt: "2026-09-14T11:00:00.000Z", accepted: 0 },
      { completedAt: "2026-09-14T12:00:00.000Z", accepted: 1 },
      { completedAt: "2026-09-15T11:00:00.000Z", accepted: 0 },
      { completedAt: null, accepted: null },
    ].map(({ completedAt, accepted }) => {
      const id = randomUUID();
      insert.run(
        id,
        Buffer.from("png"),
        "2020-01-01T00:00:00.000Z",
        completedAt,
        accepted,
      );
      return { id, completedAt };
    });
    db.close();

    await handler(ctx);

    const reopened = openScreenCaptureDb();
    try {
      const remaining = reopened
        .prepare("SELECT id FROM screen_captures ORDER BY id")
        .all()
        .map((row) => (row as { id: string }).id);
      expect(remaining.sort()).toEqual(
        rows
          .slice(2)
          .map(({ id }) => id)
          .sort(),
      );
    } finally {
      reopened.close();
    }
  });
});
