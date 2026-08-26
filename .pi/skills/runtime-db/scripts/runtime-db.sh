#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$ROOT"

exec node --input-type=module - "$@" <<'NODE'
import path from "node:path";
import Database from "better-sqlite3";

const root = process.cwd();
const args = process.argv.slice(2);
const command = args[0] ?? "help";
const configured = process.env.RUNTIME_DB_PATH;
const dbPath = configured
  ? path.isAbsolute(configured)
    ? configured
    : path.resolve(root, configured)
  : path.join(root, "data/runtime.sqlite");

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function usage() {
  console.log(`Usage: runtime-db.sh <command> [args]

Commands:
  path
  tables
  schema [table]
  jobs [limit]
  job <id>
  deliveries [limit]
  delivery <id>
  idempotency [limit]
  cursors
  query <SELECT|PRAGMA|WITH|EXPLAIN statement>`);
}

if (command === "help" || command === "-h" || command === "--help") {
  usage();
  process.exit(0);
}

if (command === "path") {
  console.log(dbPath);
  process.exit(0);
}

let db;
try {
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
} catch (error) {
  console.error(`Failed to open runtime DB read-only: ${dbPath}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const limit = (value, fallback = 20) => {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) return fallback;
  return parsed;
};

try {
  switch (command) {
    case "tables": {
      print(
        db
          .prepare(
            "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY type, name",
          )
          .all(),
      );
      break;
    }
    case "schema": {
      const table = args[1];
      if (table) {
        const row = db
          .prepare(
            "SELECT name, type, sql FROM sqlite_master WHERE name = ? AND type IN ('table','view','index','trigger')",
          )
          .get(table);
        print(row ?? null);
      } else {
        print(
          db
            .prepare(
              "SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
            )
            .all(),
        );
      }
      break;
    }
    case "jobs": {
      print(
        db
          .prepare(
            `SELECT id, status, session_id, attempts, max_attempts,
                    next_attempt_at, lease_until, worker_id, fencing_token,
                    succeeded, result_state, terminal_reason, created_at, updated_at
             FROM jobs ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit(args[1])),
      );
      break;
    }
    case "job": {
      if (!args[1]) throw new Error("job requires <id>");
      print(db.prepare("SELECT * FROM jobs WHERE id = ?").get(args[1]) ?? null);
      break;
    }
    case "deliveries": {
      print(
        db
          .prepare(
            `SELECT id, job_id, status, destination_type, destination_id,
                    response_index, external_message_id, attempts,
                    next_attempt_at, lease_until, worker_id, fencing_token,
                    last_error, created_at
             FROM deliveries ORDER BY created_at DESC LIMIT ?`,
          )
          .all(limit(args[1])),
      );
      break;
    }
    case "delivery": {
      if (!args[1]) throw new Error("delivery requires <id>");
      print(db.prepare("SELECT * FROM deliveries WHERE id = ?").get(args[1]) ?? null);
      break;
    }
    case "idempotency": {
      print(
        db
          .prepare(
            "SELECT * FROM idempotency_keys ORDER BY created_at DESC LIMIT ?",
          )
          .all(limit(args[1])),
      );
      break;
    }
    case "cursors": {
      print(db.prepare("SELECT * FROM discord_sync_cursors").all());
      break;
    }
    case "query": {
      const sql = args.slice(1).join(" ").trim();
      if (!sql) throw new Error("query requires a SQL statement");
      if (!/^(SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql)) {
        throw new Error("query only accepts SELECT, PRAGMA, WITH, or EXPLAIN");
      }
      const statement = db.prepare(sql);
      if (!statement.reader) throw new Error("query must be read-only");
      print(statement.all());
      break;
    }
    default:
      usage();
      process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  db.close();
}
NODE
