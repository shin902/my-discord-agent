import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { MemoryCaptureTurn } from "./types.js";

/** Projection of successful remote acceptance only; never a queue. */
export class MemoryExportLedger {
  private readonly db: Database.Database;

  constructor(
    filename = path.join(process.cwd(), "data", "memory-export.sqlite"),
  ) {
    if (filename !== ":memory:")
      mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    try {
      this.db.pragma("busy_timeout = 5000");
      this.db.exec(`CREATE TABLE IF NOT EXISTS exports (
        backend_id TEXT NOT NULL,
        group_name TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        exported_at TEXT NOT NULL,
        PRIMARY KEY (backend_id, group_name, source_kind, source_id)
      )`);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  has(backendId: string, turn: MemoryCaptureTurn): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM exports
      WHERE backend_id=? AND group_name=? AND source_kind=? AND source_id=?`)
        .get(
          backendId,
          turn.groupName,
          turn.source.kind,
          turn.source.sourceId,
        ) !== undefined
    );
  }

  record(backendId: string, turn: MemoryCaptureTurn): void {
    this.db
      .prepare("INSERT OR IGNORE INTO exports VALUES (?, ?, ?, ?, ?)")
      .run(
        backendId,
        turn.groupName,
        turn.source.kind,
        turn.source.sourceId,
        new Date().toISOString(),
      );
  }

  close(): void {
    this.db.close();
  }
}
