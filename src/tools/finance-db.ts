import { mkdirSync } from "node:fs";
import { createRequire as createFinanceDbRequire } from "node:module";
import path from "node:path";
import type Database from "better-sqlite3";

const require = createFinanceDbRequire(import.meta.url);

export function withFinanceDatabase<T>(
  dbPath: string,
  operation: (db: Database.Database) => T,
): T {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const DatabaseConstructor = require("better-sqlite3") as typeof Database;
  const db = new DatabaseConstructor(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        amount INTEGER NOT NULL,
        category TEXT,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        amount INTEGER NOT NULL,
        cycle TEXT NOT NULL,
        next_date TEXT NOT NULL,
        category TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const columns = db
      .prepare("PRAGMA table_info(subscriptions)")
      .all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === "recorded_at")) {
      db.exec("ALTER TABLE subscriptions ADD COLUMN recorded_at TEXT");
    }

    return operation(db);
  } finally {
    db.close();
  }
}
