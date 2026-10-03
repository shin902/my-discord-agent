import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openScreenCaptureDb } from "./store.js";

it("migrates existing capture dates once and commits later observed days with their images", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "screen-day-migration-"),
  );
  const filename = path.join(directory, "captures.sqlite");
  try {
    const legacy = new Database(filename);
    legacy.exec(`CREATE TABLE screen_captures (
      id TEXT PRIMARY KEY, image BLOB NOT NULL, received_at TEXT NOT NULL,
      summary TEXT, completed_at TEXT, accepted INTEGER
    )`);
    legacy
      .prepare(
        "INSERT INTO screen_captures(id,image,received_at) VALUES (?,?,?)",
      )
      .run(randomUUID(), Buffer.from("image"), "2026-09-10T15:00:00Z");
    legacy.close();
    const migrated = openScreenCaptureDb(filename);
    expect(
      migrated.prepare("SELECT date FROM screen_capture_days").all(),
    ).toEqual([{ date: "2026-09-11" }]);
    migrated.exec("DELETE FROM screen_captures");
    migrated.close();
    const reopened = openScreenCaptureDb(filename);
    try {
      const insert = reopened.prepare(
        "INSERT INTO screen_captures(id,image,received_at) VALUES (?,?,?)",
      );
      expect(() =>
        reopened.transaction(() => {
          insert.run(
            randomUUID(),
            Buffer.from("image"),
            "2026-09-12T00:00:00Z",
          );
          throw new Error("rollback");
        })(),
      ).toThrow("rollback");
      expect(
        reopened.prepare("SELECT date FROM screen_capture_days").all(),
      ).toEqual([{ date: "2026-09-11" }]);
      insert.run(randomUUID(), Buffer.from("image"), "2026-09-13T14:59:59Z");
      expect(
        reopened
          .prepare("SELECT date FROM screen_capture_days ORDER BY date")
          .all(),
      ).toEqual([{ date: "2026-09-11" }, { date: "2026-09-13" }]);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
