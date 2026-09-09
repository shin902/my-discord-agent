import { lstatSync, mkdirSync } from "node:fs";
import { createRequire as createFinanceDbRequire } from "node:module";
import path from "node:path";
import type Database from "better-sqlite3";

const require = createFinanceDbRequire(import.meta.url);

/** Fixed path inside the disposable Tool Runtime, never supplied by an agent. */
export const FINANCE_RUNTIME_DB_PATH = "/var/lib/finance/finance.db";

export type FinanceDbAccess = "read-only" | "read-write";

/**
 * Create the finance schema and apply the only compatibility migration needed
 * by the append-only subscription history. Existing rows are never rewritten.
 */
export function ensureFinanceDatabase(dbPath: string): void {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  try {
    const stat = lstatSync(dbPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Finance database must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const DatabaseConstructor = require("better-sqlite3") as typeof Database;
  const db = new DatabaseConstructor(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        date        TEXT    NOT NULL,
        amount      INTEGER NOT NULL,
        category    TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT    NOT NULL,
        amount      INTEGER NOT NULL,
        cycle       TEXT    NOT NULL,
        next_date   TEXT    NOT NULL,
        category    TEXT,
        active      INTEGER NOT NULL DEFAULT 1,
        recorded_at TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const columns = db
      .prepare("PRAGMA table_info(subscriptions)")
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "recorded_at")) {
      // SQLite cannot add a non-constant CURRENT_TIMESTAMP default with ALTER
      // TABLE. Leave legacy rows NULL and write the timestamp on new inserts.
      db.exec("ALTER TABLE subscriptions ADD COLUMN recorded_at TEXT");
    }
  } finally {
    db.close();
  }
}

/** Resolve only a configured group's finance database beneath the trusted root. */
export function resolveFinanceDatabasePath(
  root: string,
  groupName: string | undefined,
): string {
  if (!groupName || !/^[a-zA-Z0-9_-]+$/.test(groupName)) {
    throw new Error(
      "Finance capability requires a valid trusted group context",
    );
  }
  return path.resolve(root, "groups", groupName, "finance.db");
}
