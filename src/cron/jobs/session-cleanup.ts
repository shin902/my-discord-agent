import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { SESSIONS_DIR } from "../../agent/session.js";
import type { CronContext } from "../runner.js";

/** Only tagged per-run cron sessions are eligible; legacy untagged sessions remain untouched. */
export async function cleanupEphemeralCronSessions(
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const groupName of await readdir(SESSIONS_DIR).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  )) {
    const dbPath = path.join(SESSIONS_DIR, groupName, "sessions.sqlite");
    if (!existsSync(dbPath)) continue;
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      // Never delete from an unknown or unmigrated schema.
      if (db.pragma("user_version", { simple: true }) !== 4) {
        throw new Error(`Unsupported session schema: ${dbPath}`);
      }
      removed += db
        .prepare(
          "DELETE FROM sessions WHERE kind = 'cron-per-run' AND updated_at < ?",
        )
        .run(now - 7 * 24 * 60 * 60 * 1000).changes;
    } finally {
      db.close();
    }
  }
  return removed;
}

export default async function handler(_ctx: CronContext): Promise<void> {
  const removed = await cleanupEphemeralCronSessions();
  console.log(`[session-cleanup] removed ${removed} expired sessions`);
}
