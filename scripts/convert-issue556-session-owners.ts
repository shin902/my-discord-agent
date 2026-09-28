import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const botTaskId = /^bot-task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Run only against stopped, backed-up stores. Group transactions are independent. */
export function convertSessionOwners(runtimePath: string, sessionsRoot: string): void {
  const groups = readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      file: path.join(sessionsRoot, entry.name, "sessions.sqlite"),
    }))
    .filter(({ file }) => existsSync(file));
  // Preflight every group before the first write.
  for (const { file } of groups) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      if (db.pragma("user_version", { simple: true }) !== 4)
        throw new Error(`Expected schema v4: ${file}`);
    } finally {
      db.close();
    }
  }
  const runtime = new Database(runtimePath, { readonly: true, fileMustExist: true });
  try {
    const owners = runtime.prepare(
      "SELECT session_id, bot_id FROM bot_task_sessions WHERE group_name=?",
    );
    for (const { name, file } of groups) {
      const registered = new Map(
        (owners.all(name) as Array<{ session_id: string; bot_id: string }>).map(
          ({ session_id, bot_id }) => [session_id, bot_id],
        ),
      );
      const db = new Database(file, { fileMustExist: true });
      try {
        db.pragma("foreign_keys = ON");
        db.transaction(() => {
          if (db.pragma("user_version", { simple: true }) !== 4)
            throw new Error(`Expected schema v4: ${file}`);
          db.exec("ALTER TABLE sessions ADD COLUMN agent_id TEXT NOT NULL DEFAULT 'main'");
          const update = db.prepare("UPDATE sessions SET agent_id=? WHERE id=?");
          const remove = db.prepare("DELETE FROM sessions WHERE id=?");
          for (const { id } of db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>) {
            const owner = registered.get(id);
            if (owner) update.run(owner, id);
            else if (botTaskId.test(id)) remove.run(id);
          }
          db.exec("CREATE INDEX sessions_agent_id_id ON sessions(agent_id, id)");
          db.pragma("user_version = 5");
        }).immediate();
      } finally {
        db.close();
      }
    }
  } finally {
    runtime.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [runtimePath, sessionsRoot] = process.argv.slice(2);
  if (!runtimePath || !sessionsRoot || process.argv.length !== 4)
    throw new Error("Usage: convert-issue556-session-owners <runtime.sqlite> <sessions-root>");
  convertSessionOwners(runtimePath, sessionsRoot);
}
