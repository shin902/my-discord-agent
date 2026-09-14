import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Host-only: image and initial unread state commit together, with no file/DB gap. */
export function openScreenCaptureDb(
  filename = path.resolve(
    ROOT,
    process.env.SCREEN_CAPTURE_DB_PATH ?? "data/screen-captures.sqlite",
  ),
): Database.Database {
  if (filename !== ":memory:")
    mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  try {
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");
    db.exec(`CREATE TABLE IF NOT EXISTS screen_captures (
      id TEXT PRIMARY KEY NOT NULL,
      image BLOB NOT NULL CHECK(length(image) > 0),
      received_at TEXT NOT NULL,
      summary TEXT CHECK(summary IS NULL OR length(trim(summary)) > 0),
      completed_at TEXT,
      accepted INTEGER CHECK(accepted IS NULL OR accepted IN (0, 1))
    );`);
    const columns = db.pragma("table_info(screen_captures)") as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "completed_at"))
      db.exec("ALTER TABLE screen_captures ADD COLUMN completed_at TEXT");
    if (!columns.some((column) => column.name === "accepted")) {
      db.exec(`ALTER TABLE screen_captures ADD COLUMN accepted INTEGER
        CHECK(accepted IS NULL OR accepted IN (0, 1));
        UPDATE screen_captures SET accepted = 1 WHERE completed_at IS NOT NULL;`);
    }
    db.exec(`DROP INDEX IF EXISTS screen_captures_unread;
    CREATE INDEX IF NOT EXISTS screen_captures_uncompleted
      ON screen_captures(received_at, id) WHERE completed_at IS NULL;`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
