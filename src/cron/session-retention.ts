import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { loadMessages } from "../agent/session.js";

const sessionsDir =
  process.env.SESSIONS_DIR || path.join(process.cwd(), "data", "sessions");

export async function markEphemeralCronSession(
  groupName: string,
  sessionId: string,
): Promise<void> {
  // Let the session store validate names and initialize/migrate its schema.
  await loadMessages(groupName, sessionId, "main");
  const db = new Database(
    path.join(sessionsDir, groupName, "sessions.sqlite"),
    { fileMustExist: true },
  );
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO sessions(agent_id, id, kind, created_at, updated_at)
      VALUES ('main', ?, 'cron-per-run', ?, ?) ON CONFLICT(agent_id, id) DO NOTHING`).run(
      sessionId,
      now,
      now,
    );
  } finally {
    db.close();
  }
}

/** Only tagged per-run cron sessions are eligible; legacy untagged sessions remain untouched. */
export async function cleanupEphemeralCronSessions(
  now = Date.now(),
): Promise<number> {
  let removed = 0;
  for (const groupName of await readdir(sessionsDir).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  )) {
    const dbPath = path.join(sessionsDir, groupName, "sessions.sqlite");
    if (!existsSync(dbPath)) continue;
    const db = new Database(dbPath, { fileMustExist: true });
    try {
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
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
