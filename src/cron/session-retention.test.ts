import { mkdtemp, rm, stat } from "node:fs/promises";
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

it("tags and expires only the selected owner at a shared session ID", async () => {
  const now = Date.now();
  await retention.markEphemeralCronSession("owner-neutral", "shared");
  await retention.markEphemeralCronSession("owner-neutral", "shared", "worker");
  await session.appendMessage(
    "owner-neutral",
    "shared",
    { role: "user", content: "bot", timestamp: now },
    "worker",
  );
  const db = new Database(path.join(root, "owner-neutral", "sessions.sqlite"));
  expect(
    db.prepare("SELECT agent_id, kind FROM sessions ORDER BY agent_id").all(),
  ).toEqual([
    { agent_id: "main", kind: "cron-per-run" },
    { agent_id: "worker", kind: "cron-per-run" },
  ]);
  db.prepare(
    "UPDATE sessions SET updated_at=? WHERE agent_id='worker' AND id='shared'",
  ).run(now - 8 * 86_400_000);
  expect(await retention.cleanupEphemeralCronSessions(now)).toBe(1);
  expect(
    db.prepare("SELECT agent_id FROM sessions WHERE id='shared'").all(),
  ).toEqual([{ agent_id: "main" }]);
  db.close();
});

it("expires per-run histories across groups and reclaims disk without deleting destination or normal histories", async () => {
  const now = Date.now();
  const originalSizes = new Map<string, number>();
  for (const group of ["cleanup-a", "cleanup-b"]) {
    await retention.markEphemeralCronSession(group, "expired");
    await retention.markEphemeralCronSession(group, "recent");
    for (const id of ["expired", "recent", "destination", "normal"]) {
      await session.appendMessage(
        group,
        id,
        {
          role: "user",
          content: id === "expired" ? "x".repeat(1_000_000) : id,
          timestamp: now,
        },
        "main",
      );
    }
    const db = new Database(path.join(root, group, "sessions.sqlite"));
    db.prepare(
      "UPDATE sessions SET updated_at=? WHERE id IN ('expired','destination','normal')",
    ).run(now - 8 * 86_400_000);
    db.prepare("UPDATE sessions SET updated_at=? WHERE id='recent'").run(
      now - 7 * 86_400_000,
    );
    if (group === "cleanup-a") db.pragma("user_version = 1");
    db.close();
    originalSizes.set(
      group,
      (await stat(path.join(root, group, "sessions.sqlite"))).size,
    );
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
    expect(db.pragma("freelist_count", { simple: true })).toBe(0);
    db.close();
    expect(
      (await stat(path.join(root, group, "sessions.sqlite"))).size,
    ).toBeLessThan(originalSizes.get(group) ?? 0);
  }
});
