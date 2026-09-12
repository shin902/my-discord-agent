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
      summary TEXT CHECK(summary IS NULL OR length(trim(summary)) > 0)
    );
    CREATE INDEX IF NOT EXISTS screen_captures_unread
      ON screen_captures(received_at, id) WHERE summary IS NULL;`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
