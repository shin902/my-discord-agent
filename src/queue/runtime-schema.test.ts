import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { collectObservability } from "./observability.js";
import {
  configureRuntimeDb,
  openRuntimeDb,
  QUEUE_SCHEMA_VERSION,
  QueueRepository,
} from "./repository.js";

/**
 * Regression tests for the version-driven runtime schema migration. The fixture
 * schemas below snapshot historically deployed shapes (legacy v1 store,
 * delivery-column-deficient store, idempotency completed_at-deficient store) so
 * upgrading existing installations and re-initializing already migrated ones must
 * stay safe.
 */

const LEGACY_V1_SCHEMA = `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','retry_wait','running','completed','dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  next_attempt_at TEXT,
  lease_until TEXT,
  worker_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_until TEXT,
  worker_id TEXT,
  fencing_token INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX deliveries_job ON deliveries(job_id);
CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK(status IN ('active','completed','dead_letter')),
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  payload_json TEXT,
  error TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status, next_attempt_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS jobs_idempotency ON jobs(idempotency_key);
CREATE INDEX IF NOT EXISTS deliveries_claim ON deliveries(status, next_attempt_at, lease_until, created_at);
CREATE INDEX IF NOT EXISTS dead_letters_job ON dead_letters(job_id, created_at);
`;

// Snapshot of the current modern jobs table shape (mirrors JOB_COLUMNS in
// repository.ts) used to build "jobs modern, deliveries stale" and
// "idempotency completed_at-deficient" fixtures.
const MODERN_JOBS_COLUMNS = `id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, payload_json TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('queued','retry_wait','claimed','running','completed','dead_letter')), claimed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10, next_attempt_at TEXT, lease_until TEXT, worker_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, claimed_at TEXT, started_at TEXT, heartbeat_at TEXT, exit_code INTEGER, termination TEXT, stop_reason TEXT, usage_json TEXT, timing_json TEXT, error_json TEXT, result_json TEXT, result_state TEXT, terminal_reason TEXT, succeeded INTEGER NOT NULL DEFAULT 0, delivery_id TEXT, agents_snapshot_hash TEXT, memory_snapshot_hash TEXT, snapshot_hash TEXT, tool_call_key TEXT, workspace_path TEXT, conversation_path TEXT`;

const MODERN_JOBS_COLUMNS_WITHOUT_RESULT_STATE = MODERN_JOBS_COLUMNS.replace(
  ", result_state TEXT,",
  ",",
);

// The afb-era deliveries table: no durable-delivery columns, unique per job.
const LEGACY_DELIVERIES_COLUMNS = `id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', payload_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_until TEXT, worker_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL`;

const deliveryColumns = [
  "response_index",
  "payload_hash",
  "host_unique_key",
  "destination_type",
  "destination_id",
  "reply_message_id",
  "cron_thread_id",
  "external_message_id",
];

const tempPaths: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeTempDbPath(): string {
  const dir = join(
    tmpdir(),
    `runtime-schema-${Math.random().toString(36).slice(2)}`,
  );
  tempPaths.push(dir);
  return join(dir, "runtime.sqlite");
}

function schemaVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
    .get() as { value: string } | undefined;
  return row ? Number.parseInt(row.value, 10) : 0;
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

function expectTables(db: Database.Database): void {
  for (const table of [
    "jobs",
    "deliveries",
    "idempotency_keys",
    "dead_letters",
  ]) {
    expect(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
    ).toBeDefined();
  }
}

let sampleCounter = 0;
function enqueueSample(db: Database.Database): void {
  const repo = new QueueRepository(db);
  try {
    // A unique session guarantees a fresh claimable job even when the store
    // already contains older queued rows (legacy-migrated fixtures). Claim() picks
    // the earliest eligible row globally, so assert on claimability rather than
    // exact job identity.
    const sessionId = `sample-session-${process.pid}-${Date.now()}-${++sampleCounter}`;
    const enqueued = repo.enqueue({
      channelId: "channel",
      groupName: "group",
      sessionId,
      content: "content",
      timestamp: new Date().toISOString(),
    });
    const claimed = repo.claim("worker-a", 1_000);
    expect(claimed).toBeDefined();
    expect(claimed?.job.content).toBe("content");
    expect(typeof enqueued.job.id).toBe("string");
  } finally {
    repo.close();
  }
}

describe("runtime schema migration", () => {
  it("initializes a fresh store to the current schema version", () => {
    const db = openRuntimeDb(":memory:");
    try {
      expect(schemaVersion(db)).toBe(QUEUE_SCHEMA_VERSION);
      expectTables(db);
      expect(columnsOf(db, "jobs")).toEqual(
        expect.arrayContaining([
          "session_id",
          "sequence",
          "claimed",
          "claimed_at",
          "result_json",
          "result_state",
          "delivery_id",
        ]),
      );
      expect(columnsOf(db, "deliveries")).toEqual(
        expect.arrayContaining(deliveryColumns),
      );
      expect(columnsOf(db, "discord_sync_cursors")).toEqual(
        expect.arrayContaining(["initialized"]),
      );
      enqueueSample(db);
    } finally {
      db.close();
    }
  });

  it("migrates a v2 store to v3 Discord cursors and supports cursor I/O", () => {
    const db = openRuntimeDb(":memory:");
    try {
      db.exec(
        "DROP TABLE discord_sync_cursors; UPDATE schema_meta SET value='2' WHERE key='schema_version';",
      );

      configureRuntimeDb(db);

      expect(schemaVersion(db)).toBe(QUEUE_SCHEMA_VERSION);
      expect(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='discord_sync_cursors'",
          )
          .get(),
      ).toBeDefined();

      const repo = new QueueRepository(db);
      repo.upsertDiscordCursor("channel-v3", "2000");
      expect(repo.getDiscordCursor("channel-v3")).toBe("2000");
      repo.close();
    } finally {
      if (db.open) db.close();
    }
  });

  it("migrates a legacy v1 store, preserving jobs, deliveries, idempotency keys and dead letters", () => {
    const db = new Database(":memory:");
    try {
      db.exec(LEGACY_V1_SCHEMA);
      db.exec(
        `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO schema_meta VALUES ('schema_version','1');`,
      );
      db.exec(
        `INSERT INTO jobs(id,idempotency_key,payload_json,status,attempts,max_attempts,created_at,updated_at) VALUES
         ('legacy-active','key-active','{"id":"legacy-active","channelId":"c","groupName":"g","sessionId":"session","content":"hi","timestamp":"2026-01-01T00:00:00.000Z","retries":0}','queued',0,10,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
         ('legacy-done',NULL,'{"id":"legacy-done","channelId":"c","groupName":"g","sessionId":"session","content":"old","timestamp":"2026-01-01T00:00:00.000Z","retries":0}','completed',1,10,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      );
      db.exec(
        `INSERT INTO deliveries(id,job_id,status,created_at,updated_at) VALUES ('delivery-1','legacy-active','pending','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`,
      );
      db.exec(
        `INSERT INTO idempotency_keys(key,job_id,status,created_at) VALUES ('key-active','legacy-active','active','2026-01-01T00:00:00.000Z');`,
      );
      db.exec(
        `INSERT INTO dead_letters(job_id,reason,source,created_at) VALUES ('legacy-active','old','migration','2026-01-01T00:00:00.000Z');`,
      );

      configureRuntimeDb(db);

      expect(schemaVersion(db)).toBe(QUEUE_SCHEMA_VERSION);
      expectTables(db);
      expect(columnsOf(db, "jobs")).toEqual(
        expect.arrayContaining([
          "claimed",
          "session_id",
          "sequence",
          "claimed_at",
          "result_json",
        ]),
      );
      const jobs = db.prepare("SELECT * FROM jobs ORDER BY id").all() as Array<{
        id: string;
        status: string;
        session_id: string;
        sequence: number;
        result_state: string | null;
        succeeded: number;
      }>;
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({
        id: "legacy-active",
        status: "queued",
        session_id: "session",
        sequence: 0,
      });
      expect(jobs[1]).toMatchObject({
        id: "legacy-done",
        status: "completed",
        session_id: "session",
        sequence: 1,
        succeeded: 1,
      });
      // delivery row survived and was backfilled with durable-column defaults
      const delivery = db
        .prepare("SELECT * FROM deliveries WHERE id='delivery-1'")
        .get() as { response_index: number; host_unique_key: string };
      expect(delivery.response_index).toBe(0);
      expect(delivery.host_unique_key).toBe("legacy-active:0");
      expect(
        db
          .prepare(
            "SELECT key,status FROM idempotency_keys WHERE key='key-active'",
          )
          .get(),
      ).toMatchObject({ key: "key-active", status: "active" });
      expect(
        db
          .prepare(
            "SELECT reason FROM dead_letters WHERE job_id='legacy-active'",
          )
          .get(),
      ).toMatchObject({ reason: "old" });
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_legacy'",
          )
          .all(),
      ).toEqual([]);
      // terminate the remaining queued legacy row so the functional smoke test is
      // the only claimable job in the store
      db.exec("UPDATE jobs SET status='completed' WHERE id='legacy-active'");
      // freshly migrated store is fully functional
      enqueueSample(db);
    } finally {
      db.close();
    }
  });

  it("repairs a current-version store that is missing the durable delivery columns and the idempotency completed_at column", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE jobs (${MODERN_JOBS_COLUMNS});`);
      db.exec(`CREATE TABLE deliveries (${LEGACY_DELIVERIES_COLUMNS});`);
      db.exec(
        `CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, status TEXT NOT NULL CHECK(status IN ('active','completed','dead_letter')), created_at TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, reason TEXT NOT NULL, payload_json TEXT, error TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO schema_meta VALUES ('schema_version','2');`,
      );
      db.exec(
        `INSERT INTO jobs(id,payload_json,session_id,status,created_at,updated_at) VALUES
         ('modern-job','{"id":"modern-job","channelId":"c","groupName":"g","sessionId":"session","content":"modern","timestamp":"2026-01-01T00:00:00.000Z","retries":0}','session','queued','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
         ('modern-success','{}','session','completed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
         ('modern-empty','{}','session','completed','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),
         ('modern-dead','{}','session','dead_letter','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
         UPDATE jobs SET succeeded=1 WHERE id='modern-success';
         UPDATE jobs SET terminal_reason='max_attempts' WHERE id='modern-dead';`,
      );
      db.exec(
        `INSERT INTO deliveries(id,job_id,created_at,updated_at) VALUES ('d1','modern-job','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`,
      );

      configureRuntimeDb(db);

      expect(schemaVersion(db)).toBe(QUEUE_SCHEMA_VERSION);
      expect(columnsOf(db, "deliveries")).toEqual(
        expect.arrayContaining(deliveryColumns),
      );
      expect(columnsOf(db, "idempotency_keys")).toContain("completed_at");
      expect(
        db
          .prepare(
            "SELECT id,result_state FROM jobs WHERE status IN ('completed','dead_letter') ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "modern-dead", result_state: "max_retries" },
        { id: "modern-empty", result_state: "empty_response" },
        { id: "modern-success", result_state: "succeeded" },
      ]);
      const delivery = db
        .prepare("SELECT * FROM deliveries WHERE id='d1'")
        .get() as { response_index: number; host_unique_key: string };
      expect(delivery.response_index).toBe(0);
      expect(delivery.host_unique_key).toBe("modern-job:0");
      // repeating initialization on the same store is idempotent
      configureRuntimeDb(db);
      expect(schemaVersion(db)).toBe(QUEUE_SCHEMA_VERSION);
      db.exec("UPDATE jobs SET status='completed' WHERE id='modern-job'");
      enqueueSample(db);
    } finally {
      db.close();
    }
  });

  it("repairs result_state on a current modern store before commit and observability access", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        `CREATE TABLE jobs (${MODERN_JOBS_COLUMNS_WITHOUT_RESULT_STATE});`,
      );
      db.exec(`CREATE TABLE deliveries (${LEGACY_DELIVERIES_COLUMNS});`);
      db.exec(
        `CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, status TEXT NOT NULL CHECK(status IN ('active','completed','dead_letter')), created_at TEXT NOT NULL, completed_at TEXT);`,
      );
      db.exec(
        `CREATE TABLE dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, reason TEXT NOT NULL, payload_json TEXT, error TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO schema_meta VALUES ('schema_version','${QUEUE_SCHEMA_VERSION}');`,
      );

      expect(columnsOf(db, "jobs")).not.toContain("result_state");
      configureRuntimeDb(db);
      expect(columnsOf(db, "jobs")).toContain("result_state");

      const repo = new QueueRepository(db);
      const enqueued = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "result-state-session",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      const claimed = repo.claim("worker", 1_000);
      expect(claimed).toBeDefined();
      if (!claimed) throw new Error("expected result-state job claim");
      repo.commitResult(enqueued.job.id, claimed.fencingToken, "done");

      expect(repo.get(enqueued.job.id)).toMatchObject({
        status: "completed",
        terminalState: "succeeded",
        succeeded: true,
      });
      expect(collectObservability(db).agent).toMatchObject({
        jobs: 1,
        completed: 1,
      });
    } finally {
      db.close();
    }
  });

  it("is idempotent across repeated initialization on an already current store", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const enqueued = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      for (let index = 0; index < 3; index++) {
        configureRuntimeDb(repo.db);
        expect(schemaVersion(repo.db)).toBe(QUEUE_SCHEMA_VERSION);
        expect(repo.get(enqueued.job.id)?.content).toBe("content");
      }
      const claimed = repo.claim("worker-a", 1_000);
      expect(claimed?.job.id).toBe(enqueued.job.id);
    } finally {
      repo.close();
    }
  });

  it("reports current-version stores without silently downgrading a newer schema", () => {
    const db = new Database(":memory:");
    try {
      const newerVersion = QUEUE_SCHEMA_VERSION + 1;
      db.exec(
        `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('schema_version','${newerVersion}');`,
      );
      expect(() => configureRuntimeDb(db)).toThrow(/newer|exceeds/i);
      expect(schemaVersion(db)).toBe(newerVersion);
    } finally {
      db.close();
    }
  });

  it("rolls back atomically when a migration step fails", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE jobs (${MODERN_JOBS_COLUMNS});`);
      db.exec(`CREATE TABLE deliveries (${LEGACY_DELIVERIES_COLUMNS});`);
      db.exec(
        `CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, job_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT);`,
      );
      db.exec(
        `CREATE TABLE dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, reason TEXT NOT NULL, payload_json TEXT, error TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);`,
      );
      db.exec(
        `CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         INSERT INTO schema_meta VALUES ('schema_version','2');`,
      );
      db.exec(
        `INSERT INTO jobs(id,payload_json,session_id,status,created_at,updated_at) VALUES ('blocked-job','{"json":"x"}','session','queued','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`,
      );
      // Two rows sharing job id -> after the backfill both would get the same
      // host_unique_key -> the unique index creation aborts the migration.
      db.exec(
        `INSERT INTO deliveries(id,job_id,created_at,updated_at) VALUES ('a','blocked-job','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z'),('b','blocked-job','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');`,
      );

      expect(() => configureRuntimeDb(db)).toThrow();
      // nothing was committed: no durable columns, no schema stamp
      expect(schemaVersion(db)).toBe(2);
      expect(columnsOf(db, "deliveries")).not.toContain("response_index");
      expect(db.prepare("SELECT id FROM deliveries ORDER BY id").all()).toEqual(
        [{ id: "a" }, { id: "b" }],
      );
      // once the contradiction is resolved the same store migrates cleanly
      db.exec("DELETE FROM deliveries WHERE id='b'");
      configureRuntimeDb(db);
      expect(schemaVersion(db)).toBe(QUEUE_SCHEMA_VERSION);
      expect(columnsOf(db, "deliveries")).toContain("response_index");
    } finally {
      db.close();
    }
  });

  it("restores foreign_keys when the migration cannot acquire the IMMEDIATE write lock", () => {
    // busy_timeout inside configureRuntimeDb waits up to 5s for the write
    // lock before BEGIN IMMEDIATE fails, so this regression test needs more
    // than the default vitest timeout.
    const dbPath = makeTempDbPath();
    const holder = openRuntimeDb(dbPath);
    try {
      // A second connection holding the write lock forces BEGIN IMMEDIATE in
      // migrateRuntimeSchema to fail after busy_timeout. foreign_keys was
      // already disabled before the BEGIN attempt, so the failed lock
      // acquisition must leave the injected connection with enforcement ON.
      holder.exec("BEGIN IMMEDIATE");
      const blocked = new Database(dbPath, { timeout: 0 });
      try {
        expect(() => configureRuntimeDb(blocked)).toThrow(/locked/i);
        expect(blocked.pragma("foreign_keys", { simple: true })).toBe(1);
      } finally {
        blocked.close();
      }
      holder.exec("ROLLBACK");
      // once the lock is released the same file initializes cleanly again
      const after = openRuntimeDb(dbPath);
      try {
        expect(schemaVersion(after)).toBe(QUEUE_SCHEMA_VERSION);
      } finally {
        after.close();
      }
    } finally {
      holder.close();
    }
  }, 15_000);

  it("configures a file-backed store exactly once and keeps it working across reopen", async () => {
    const dbPath = makeTempDbPath();
    const repo = new QueueRepository(dbPath);
    try {
      expect(schemaVersion(repo.db)).toBe(QUEUE_SCHEMA_VERSION);
      enqueueSample(repo.db);
    } finally {
      repo.close();
    }
    // reopening the existing file re-runs the idempotent initialization
    const reopened = new QueueRepository(dbPath);
    try {
      expect(schemaVersion(reopened.db)).toBe(QUEUE_SCHEMA_VERSION);
      enqueueSample(reopened.db);
    } finally {
      reopened.close();
    }
  });

  it("configures :memory: openRuntimeDb and injected Database identically", () => {
    const fromOpen = openRuntimeDb(":memory:");
    try {
      expect(schemaVersion(fromOpen)).toBe(QUEUE_SCHEMA_VERSION);
      expectTables(fromOpen);
    } finally {
      fromOpen.close();
    }
    const injected = new Database(":memory:");
    try {
      configureRuntimeDb(injected);
      expect(schemaVersion(injected)).toBe(QUEUE_SCHEMA_VERSION);
      expectTables(injected);
    } finally {
      injected.close();
    }
  });
});
