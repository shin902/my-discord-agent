import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, expect, it } from "vitest";

let root: string;
let retention: typeof import("./session-retention.js");
let session: typeof import("../agent/session.js");

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cron-retention-"));
  process.env.SESSIONS_DIR = root;
  session = await import("../agent/session.js");
  retention = await import("./session-retention.js");
});

afterAll(async () => {
  delete process.env.SESSIONS_DIR;
  await rm(root, { recursive: true, force: true });
});

it("deletes only expired tagged cron sessions and cascades entries across groups", async () => {
  const now = Date.now();
  for (const group of ["cleanup-a", "cleanup-b"]) {
    await retention.markEphemeralCronSession(group, "expired");
    await retention.markEphemeralCronSession(group, "recent");
    for (const id of ["expired", "recent", "destination", "normal"]) {
      await session.appendMessage(group, id, {
        role: "user",
        content: id,
        timestamp: now,
      });
    }
    const db = new Database(path.join(root, group, "sessions.sqlite"));
    db.prepare(
      "UPDATE sessions SET updated_at=? WHERE id IN ('expired','destination','normal')",
    ).run(now - 8 * 86_400_000);
    db.close();
  }
  expect(await retention.cleanupEphemeralCronSessions(now)).toBe(2);
  expect(await retention.cleanupEphemeralCronSessions(now)).toBe(0);
  for (const group of ["cleanup-a", "cleanup-b"]) {
    const db = new Database(path.join(root, group, "sessions.sqlite"), {
      readonly: true,
    });
    expect(db.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([
      { id: "destination" },
      { id: "normal" },
      { id: "recent" },
    ]);
    expect(
      db
        .prepare("SELECT session_id FROM session_entries ORDER BY session_id")
        .all(),
    ).toEqual([
      { session_id: "destination" },
      { session_id: "normal" },
      { session_id: "recent" },
    ]);
    db.close();
  }
});
