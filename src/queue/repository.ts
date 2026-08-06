import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { InboxMessage } from "./inbox.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_RUNTIME_DB_PATH = path.join(ROOT, "data/runtime.sqlite");
export const QUEUE_SCHEMA_VERSION = 1;
export type JobStatus = "queued" | "retry_wait" | "running" | "completed" | "dead_letter";
export interface QueueJob extends InboxMessage {
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  leaseUntil?: string;
  workerId?: string;
  fencingToken: number;
  lastError?: string;
}
export interface ClaimedJob { job: QueueJob; fencingToken: number }
export interface EnqueueResult { job: QueueJob; inserted: boolean }
export interface LegacyMigrationResult { migrated: number; completed: number; malformed: number; deadLetters: number; backupPaths: string[] }
export interface IdempotencyRecord { key: string; jobId: string | null; status: "active" | "completed" | "dead_letter" }

interface JobRow {
  id: string; idempotency_key: string | null; payload_json: string; status: JobStatus;
  attempts: number; max_attempts: number; next_attempt_at: string | null;
  lease_until: string | null; worker_id: string | null; fencing_token: number;
  last_error: string | null; created_at: string; updated_at: string; completed_at: string | null;
}

function nowIso(): string { return new Date().toISOString(); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function parsePayload(row: JobRow): QueueJob {
  const payload = JSON.parse(row.payload_json) as InboxMessage;
  return {
    ...payload,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    fencingToken: row.fencing_token,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

export function resolveRuntimeDbPath(configured?: string): string {
  const value = configured ?? process.env.RUNTIME_DB_PATH;
  if (!value) return DEFAULT_RUNTIME_DB_PATH;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}

export function configureRuntimeDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO schema_meta(key, value) VALUES ('schema_version', '${QUEUE_SCHEMA_VERSION}')
      ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    CREATE TABLE IF NOT EXISTS jobs (
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
    CREATE TABLE IF NOT EXISTS deliveries (
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
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('active','completed','dead_letter')),
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS dead_letters (
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
  `);
}

export function openRuntimeDb(configuredPath?: string): Database.Database {
  if (configuredPath === ":memory:") {
    const db = new Database(":memory:");
    configureRuntimeDb(db);
    return db;
  }
  const dbPath = resolveRuntimeDbPath(configuredPath);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  configureRuntimeDb(db);
  return db;
}

function syntheticCompleted(payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">, key: string): QueueJob {
  const timestamp = nowIso();
  return {
    ...payload,
    id: `idempotency-${key}`,
    retries: 0,
    enqueuedAt: timestamp,
    idempotencyKey: key,
    status: "completed",
    attempts: 0,
    maxAttempts: 0,
    completedAt: timestamp,
    fencingToken: 0,
  };
}

export class QueueRepository {
  readonly db: Database.Database;
  readonly workerId: string;
  constructor(dbOrPath?: Database.Database | string, workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`) {
    this.db = typeof dbOrPath === "string" || dbOrPath === undefined ? openRuntimeDb(dbOrPath) : dbOrPath;
    configureRuntimeDb(this.db);
    this.workerId = workerId;
  }
  close(): void { this.db.close(); }
  get(id: string): QueueJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
    return row ? parsePayload(row) : undefined;
  }
  findByIdempotencyKey(key: string): QueueJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key=?").get(key) as JobRow | undefined;
    return row ? parsePayload(row) : undefined;
  }
  enqueue(payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">, options: { idempotencyKey?: string; maxAttempts?: number } = {}): EnqueueResult {
    const key = options.idempotencyKey ?? payload.idempotencyKey;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (key) {
        const idem = this.db.prepare("SELECT key,job_id,status FROM idempotency_keys WHERE key=?").get(key) as { key: string; job_id: string | null; status: string } | undefined;
        if (idem) {
          const existing = idem.job_id ? this.get(idem.job_id) : undefined;
          this.db.exec("COMMIT");
          return { job: existing ?? syntheticCompleted(payload, key), inserted: false };
        }
      }
      const id = `job-${randomUUID()}`;
      const timestamp = nowIso();
      const record = { id, retries: 0, ...payload, enqueuedAt: timestamp, ...(key ? { idempotencyKey: key } : {}) } as InboxMessage;
      this.db.prepare(`INSERT INTO jobs
        (id,idempotency_key,payload_json,status,attempts,max_attempts,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, key ?? null, JSON.stringify(record), "queued", 0, options.maxAttempts ?? 10, timestamp, timestamp);
      if (key) this.db.prepare("INSERT INTO idempotency_keys(key,job_id,status,created_at) VALUES(?,?,?,?)").run(key, id, "active", timestamp);
      const result = { job: this.get(id)!, inserted: true };
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }
  claim(workerId = this.workerId, leaseMs = 60_000, at = new Date(), excludeIds: ReadonlySet<string> = new Set()): ClaimedJob | undefined {
    const now = at.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const excluded = [...excludeIds];
      const where = excluded.length ? ` AND id NOT IN (${excluded.map(() => "?").join(",")})` : "";
      const eligible = `(
        (status IN ('queued','retry_wait') AND (next_attempt_at IS NULL OR next_attempt_at<=?))
        OR (status='running' AND lease_until<=?)
      )`;
      const exhausted = this.db.prepare(`SELECT * FROM jobs WHERE ${eligible} AND attempts>=max_attempts${where}`)
        .all(now, now, ...excluded) as JobRow[];
      for (const row of exhausted) this.deadLetterExhaustedInTransaction(row, "max_attempts");

      const row = this.db.prepare(`SELECT * FROM jobs WHERE
        ${eligible} AND attempts<max_attempts${where}
        ORDER BY created_at LIMIT 1`).get(now, now, ...excluded) as JobRow | undefined;
      if (!row) { this.db.exec("COMMIT"); return undefined; }
      const token = row.fencing_token + 1;
      const leaseUntil = new Date(at.getTime() + Math.max(1, leaseMs)).toISOString();
      const result = this.db.prepare(`UPDATE jobs SET status='running',worker_id=?,lease_until=?,fencing_token=?,attempts=attempts+1,updated_at=?
        WHERE id=? AND fencing_token=? AND (status IN ('queued','retry_wait') OR (status='running' AND lease_until<=?)) AND attempts<max_attempts`).run(workerId, leaseUntil, token, now, row.id, row.fencing_token, now);
      if (result.changes !== 1) throw new Error(`claim race for job ${row.id}`);
      this.db.exec("COMMIT");
      const claimed = this.get(row.id);
      return claimed ? { job: claimed, fencingToken: token } : undefined;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
      throw error;
    }
  }
  private fenced(id: string, token: number, update: Record<string, unknown>): void {
    const sets = Object.keys(update).map((key) => `${key}=@${key}`).join(",");
    const result = this.db.prepare(`UPDATE jobs SET ${sets},updated_at=@updated_at WHERE id=@id AND status='running' AND fencing_token=@token`)
      .run({ ...update, updated_at: nowIso(), id, token });
    if (result.changes !== 1) throw new Error(`stale fencing token for job ${id}`);
  }
  private updatePayload(id: string, token: number, patch: Partial<InboxMessage>): void {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    const payload = { ...job } as Record<string, unknown>;
    for (const key of ["status", "attempts", "maxAttempts", "nextAttemptAt", "leaseUntil", "workerId", "fencingToken", "lastError"]) delete payload[key];
    const sanitizedPatch = { ...patch } as Record<string, unknown>;
    for (const key of ["fencingToken", "workerId", "lastError", "status", "attempts", "maxAttempts", "nextAttemptAt", "leaseUntil"]) delete sanitizedPatch[key];
    Object.assign(payload, sanitizedPatch);
    this.fenced(id, token, { payload_json: JSON.stringify(payload) });
  }
  updateRunning(id: string, token: number, patch: Partial<InboxMessage>): void {
    this.updatePayload(id, token, patch);
  }
  complete(id: string, token: number): void {
    const at = nowIso();
    this.db.transaction(() => {
      this.fenced(id, token, { status: "completed", lease_until: null, worker_id: null, completed_at: at, next_attempt_at: null });
      const row = this.db.prepare("SELECT idempotency_key FROM jobs WHERE id=?").get(id) as { idempotency_key: string | null } | undefined;
      if (row?.idempotency_key) this.db.prepare("UPDATE idempotency_keys SET status='completed',completed_at=? WHERE key=?").run(at, row.idempotency_key);
    })();
  }
  retry(id: string, token: number, error: unknown, delayMs = 1000, payloadPatch?: Partial<InboxMessage>): void {
    const message = errorMessage(error);
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT attempts,max_attempts FROM jobs WHERE id=?").get(id) as { attempts: number; max_attempts: number } | undefined;
      if (!row) throw new Error(`unknown job ${id}`);
      if (payloadPatch) this.updatePayload(id, token, payloadPatch);
      if (row.attempts >= row.max_attempts) {
        this.deadLetterInTransaction(id, token, "max_attempts", message);
        return;
      }
      this.fenced(id, token, { status: "retry_wait", next_attempt_at: new Date(Date.now() + Math.max(0, delayMs)).toISOString(), lease_until: null, worker_id: null, last_error: message });
    })();
  }
  private deadLetterInTransaction(id: string, token: number, reason: string, error?: string, source = "queue"): void {
    const row = this.db.prepare("SELECT payload_json FROM jobs WHERE id=?").get(id) as { payload_json: string } | undefined;
    this.fenced(id, token, { status: "dead_letter", lease_until: null, worker_id: null, next_attempt_at: null, last_error: error ?? reason });
    this.db.prepare("INSERT INTO dead_letters(job_id,reason,payload_json,error,source,created_at) VALUES(?,?,?,?,?,?)").run(id, reason, row?.payload_json ?? null, error ?? null, source, nowIso());
    const key = this.db.prepare("SELECT idempotency_key FROM jobs WHERE id=?").get(id) as { idempotency_key: string | null } | undefined;
    if (key?.idempotency_key) this.db.prepare("UPDATE idempotency_keys SET status='dead_letter' WHERE key=?").run(key.idempotency_key);
  }
  private deadLetterExhaustedInTransaction(row: JobRow, reason: string): void {
    const at = nowIso();
    const error = row.last_error ?? reason;
    const result = this.db.prepare(`
      UPDATE jobs
      SET status='dead_letter', lease_until=NULL, worker_id=NULL, next_attempt_at=NULL,
        last_error=?, updated_at=?
      WHERE id=? AND status=? AND attempts>=max_attempts
    `).run(error, at, row.id, row.status);
    if (result.changes !== 1) return;
    this.db.prepare("INSERT INTO dead_letters(job_id,reason,payload_json,error,source,created_at) VALUES(?,?,?,?,?,?)")
      .run(row.id, reason, row.payload_json, error, "queue", at);
    if (row.idempotency_key) {
      this.db.prepare("UPDATE idempotency_keys SET status='dead_letter' WHERE key=?").run(row.idempotency_key);
    }
  }
  deadLetter(id: string, token: number, reason: string, error?: string): void { this.db.transaction(() => this.deadLetterInTransaction(id, token, reason, error))(); }
  renew(id: string, token: number, leaseMs = 60_000): void {
    this.fenced(id, token, { lease_until: new Date(Date.now() + Math.max(1, leaseMs)).toISOString() });
  }
  getIdempotencyRecord(key: string): IdempotencyRecord | undefined {
    return this.db.prepare("SELECT key,job_id as jobId,status FROM idempotency_keys WHERE key=?").get(key) as IdempotencyRecord | undefined;
  }
  listRssStatePaths(): string[] {
    const paths = new Set<string>();
    for (const row of this.db.prepare("SELECT payload_json FROM jobs").all() as Array<{ payload_json: string }>) {
      try {
        const value = JSON.parse(row.payload_json) as { rssStatePath?: unknown };
        if (typeof value.rssStatePath === "string" && value.rssStatePath.length > 0) paths.add(value.rssStatePath);
      } catch {
        // Queue payload validation occurs at enqueue/migration boundaries.
      }
    }
    return [...paths];
  }
  recordDeadLetter(input: { jobId?: string; reason: string; payloadJson?: string | null; error?: string; source?: string }): void {
    this.db.prepare("INSERT INTO dead_letters(job_id,reason,payload_json,error,source,created_at) VALUES(?,?,?,?,?,?)").run(input.jobId ?? null, input.reason, input.payloadJson ?? null, input.error ?? null, input.source ?? "queue", nowIso());
  }
  requeueExpired(at = new Date()): number {
    return this.db.prepare("UPDATE jobs SET status='queued',worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=? WHERE status='running' AND lease_until<=?").run(at.toISOString(), at.toISOString()).changes;
  }
  list(status?: JobStatus): QueueJob[] {
    const rows = (status ? this.db.prepare("SELECT * FROM jobs WHERE status=? ORDER BY created_at").all(status) : this.db.prepare("SELECT * FROM jobs ORDER BY created_at").all()) as JobRow[];
    return rows.map(parsePayload);
  }
  listIdempotencyKeys(): Array<{ key: string; jobId: string | null; status: string }> {
    return this.db.prepare("SELECT key,job_id as jobId,status FROM idempotency_keys ORDER BY key").all() as Array<{ key: string; jobId: string | null; status: string }>;
  }
}

let defaultRepository: QueueRepository | undefined;
export function getQueueRepository(): QueueRepository { return (defaultRepository ??= new QueueRepository()); }
export function closeQueueRepository(): void { defaultRepository?.close(); defaultRepository = undefined; }
