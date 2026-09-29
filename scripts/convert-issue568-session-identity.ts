import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/** Run only with the worker stopped and every group DB backed up. */
export function convertSessionIdentity(sessionsRoot: string): void {
  const files = readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sessionsRoot, entry.name, "sessions.sqlite"))
    .filter(existsSync);
  if (files.length === 0) throw new Error(`No session databases: ${sessionsRoot}`);

  // Validate all groups before changing any group. A failure during conversion
  // still requires restoring *all* group DBs from the same backup set.
  for (const file of files) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma("user_version", { simple: true }) !== 5)
        throw new Error(`Expected schema v5: ${file}`);
      if (db.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error(`Corrupt session DB: ${file}`);
      if ((db.pragma("foreign_key_check") as unknown[]).length)
        throw new Error(`Orphaned session entries: ${file}`);
      const missing = db.prepare(`SELECT 1 FROM session_entries e
        LEFT JOIN sessions s ON s.id=e.session_id WHERE s.id IS NULL LIMIT 1`).get();
      if (missing) throw new Error(`Orphaned session entries: ${file}`);
      const collisions = db.prepare(`SELECT 1 FROM session_entries e
        JOIN sessions s ON s.id=e.session_id
        GROUP BY s.agent_id,e.session_id,e.sequence HAVING count(*)>1 LIMIT 1`).get();
      if (collisions) throw new Error(`Duplicate entry sequence: ${file}`);
      const invalid = db.prepare("SELECT 1 FROM sessions WHERE agent_id IS NULL OR agent_id='' LIMIT 1").get();
      if (invalid) throw new Error(`Invalid owner: ${file}`);
    } finally {
      db.close();
    }
  }

  for (const file of files) {
    const db = new Database(file, { fileMustExist: true });
    try {
      db.pragma("busy_timeout = 5000");
      // FK OFF must precede BEGIN; both old tables are rebuilt in one transaction.
      db.pragma("foreign_keys = OFF");
      db.transaction(() => {
        if (db.pragma("user_version", { simple: true }) !== 5)
          throw new Error(`Expected schema v5: ${file}`);
        const highWater = (db.prepare("SELECT seq FROM sqlite_sequence WHERE name='session_entries'").get() as { seq: number } | undefined)?.seq ?? 0;
        db.exec(`
          CREATE TABLE sessions_v6 (
            id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'conversation',
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            agent_id TEXT NOT NULL, PRIMARY KEY(agent_id,id)
          );
          CREATE TABLE session_entries_v6 (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL, agent_id TEXT NOT NULL,
            sequence INTEGER NOT NULL, entry_type TEXT NOT NULL,
            payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, source_json TEXT,
            FOREIGN KEY(agent_id,session_id) REFERENCES sessions(agent_id,id)
              ON UPDATE CASCADE ON DELETE CASCADE,
            UNIQUE(agent_id,session_id,sequence)
          );
          INSERT INTO sessions_v6(id,kind,created_at,updated_at,agent_id)
            SELECT id,kind,created_at,updated_at,agent_id FROM sessions;
          INSERT INTO session_entries_v6(id,session_id,agent_id,sequence,entry_type,payload_json,created_at,source_json)
            SELECT e.id,e.session_id,s.agent_id,e.sequence,e.entry_type,e.payload_json,e.created_at,e.source_json
            FROM session_entries e JOIN sessions s ON s.id=e.session_id;
          DROP TABLE session_entries;
          DROP TABLE sessions;
          ALTER TABLE sessions_v6 RENAME TO sessions;
          ALTER TABLE session_entries_v6 RENAME TO session_entries;
          CREATE INDEX sessions_agent_id_id ON sessions(agent_id,id);
          CREATE INDEX session_entries_session_id_id ON session_entries(agent_id,session_id,id);
          CREATE INDEX session_entries_source ON session_entries(id) WHERE source_json IS NOT NULL;
        `);
        db.prepare("UPDATE sqlite_sequence SET seq=MAX(seq, ?) WHERE name='session_entries'").run(highWater);
        if ((db.pragma("foreign_key_check") as unknown[]).length)
          throw new Error(`Foreign key violation: ${file}`);
        if (db.pragma("integrity_check", { simple: true }) !== "ok")
          throw new Error(`Integrity check failed: ${file}`);
        db.pragma("user_version = 6");
      }).immediate();
      db.pragma("foreign_keys = ON");
      if ((db.pragma("foreign_key_check") as unknown[]).length || db.pragma("integrity_check", { simple: true }) !== "ok")
        throw new Error(`Post-migration integrity check failed: ${file}`);
    } finally {
      db.close();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3)
    throw new Error("Usage: convert-issue568-session-identity <sessions-root>");
  convertSessionIdentity(process.argv[2]);
}
