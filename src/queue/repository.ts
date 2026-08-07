import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { InboxMessage } from "./inbox.js";
import { splitMessage } from "../utils/splitMessage.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DEFAULT_RUNTIME_DB_PATH = path.join(ROOT, "data/runtime.sqlite");
export const QUEUE_SCHEMA_VERSION = 2;
export type JobStatus =
  | "queued"
  | "retry_wait"
  | "claimed"
  | "running"
  | "completed"
  | "dead_letter";
export type TerminalState =
  | "succeeded"
  | "empty_response"
  | "non_retryable"
  | "max_retries"
  | "dead_letter";
export interface ExecutionMetadata {
  claimedAt?: string;
  startedAt?: string;
  heartbeatAt?: string;
  exitCode?: number | null;
  termination?: string;
  stopReason?: string;
  usage?: unknown;
  timing?: unknown;
  error?: unknown;
  agentsSnapshotHash?: string;
  memorySnapshotHash?: string;
  snapshotHash?: string;
  toolCallKey?: string;
  workspacePath?: string;
  conversationPath?: string;
}
export interface QueueJob extends InboxMessage, ExecutionMetadata {
  status: JobStatus;
  executionState?: ExecutionState;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  leaseUntil?: string;
  workerId?: string;
  fencingToken: number;
  lastError?: string;
  sequence: number;
  terminalState?: TerminalState;
  resultJson?: string;
  succeeded: boolean;
  deliveryId?: string;
}
export type ExecutionState = "claimed" | "running";
export interface ClaimedJob {
  job: QueueJob;
  fencingToken: number;
}
export interface EnqueueResult {
  job: QueueJob;
  inserted: boolean;
}
export interface LegacyMigrationResult {
  migrated: number;
  completed: number;
  malformed: number;
  deadLetters: number;
  backupPaths: string[];
}
export interface IdempotencyRecord {
  key: string;
  jobId: string | null;
  status: "active" | "completed" | "dead_letter";
}
export interface DeliveryRow {
  id: string;
  jobId: string;
  status: DeliveryStatus;
  payloadJson: string | null;
  createdAt: string;
  responseIndex?: number;
  payloadHash?: string;
  hostUniqueKey?: string;
  destinationType?: string;
  destinationId?: string;
  replyMessageId?: string;
  cronThreadId?: string;
  externalMessageId?: string;
  leaseUntil?: string;
  workerId?: string;
  fencingToken?: number;
  attempts?: number;
  nextAttemptAt?: string;
  lastError?: string;
}
export type DeliveryStatus =
  | "pending"
  | "retry_wait"
  | "sending"
  | "sent"
  | "failed"
  | "ambiguous";
export interface DeliveryClaim {
  row: DeliveryRow;
  fencingToken: number;
}
interface JobRow {
  id: string;
  idempotency_key: string | null;
  payload_json: string;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  worker_id: string | null;
  fencing_token: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  session_id: string;
  sequence: number;
  claimed_at: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  exit_code: number | null;
  termination: string | null;
  stop_reason: string | null;
  usage_json: string | null;
  timing_json: string | null;
  error_json: string | null;
  result_json: string | null;
  result_state: TerminalState | null;
  terminal_reason: string | null;
  succeeded: number;
  delivery_id: string | null;
  agents_snapshot_hash: string | null;
  memory_snapshot_hash: string | null;
  snapshot_hash: string | null;
  tool_call_key: string | null;
  workspace_path: string | null;
  conversation_path: string | null;
}
export function resolveRuntimeDbPath(configured?: string): string {
  const value = configured ?? process.env.RUNTIME_DB_PATH;
  if (!value) return DEFAULT_RUNTIME_DB_PATH;
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}
function nowIso(): string {
  return new Date().toISOString();
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function jsonOrUndefined(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
function parsePayload(row: JobRow): QueueJob {
  const payload = JSON.parse(row.payload_json) as InboxMessage;
  const active = row.status === "claimed" || row.status === "running";
  return {
    ...payload,
    status: row.status === "claimed" ? "running" : row.status,
    ...(active
      ? { executionState: row.status === "claimed" ? "claimed" : "running" }
      : {}),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    ...(row.lease_until ? { leaseUntil: row.lease_until } : {}),
    ...(row.worker_id ? { workerId: row.worker_id } : {}),
    fencingToken: row.fencing_token,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    sequence: row.sequence,
    ...(row.claimed_at ? { claimedAt: row.claimed_at } : {}),
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.heartbeat_at ? { heartbeatAt: row.heartbeat_at } : {}),
    ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
    ...(row.termination ? { termination: row.termination } : {}),
    ...(row.stop_reason ? { stopReason: row.stop_reason } : {}),
    ...(row.usage_json ? { usage: jsonOrUndefined(row.usage_json) } : {}),
    ...(row.timing_json ? { timing: jsonOrUndefined(row.timing_json) } : {}),
    ...(row.error_json ? { error: jsonOrUndefined(row.error_json) } : {}),
    ...(row.result_json !== null ? { resultJson: row.result_json } : {}),
    ...(row.result_state ? { terminalState: row.result_state } : {}),
    ...(row.terminal_reason ? { terminalReason: row.terminal_reason } : {}),
    succeeded: row.succeeded === 1,
    ...(row.delivery_id ? { deliveryId: row.delivery_id } : {}),
    ...(row.agents_snapshot_hash
      ? { agentsSnapshotHash: row.agents_snapshot_hash }
      : {}),
    ...(row.memory_snapshot_hash
      ? { memorySnapshotHash: row.memory_snapshot_hash }
      : {}),
    ...(row.snapshot_hash ? { snapshotHash: row.snapshot_hash } : {}),
    ...(row.tool_call_key ? { toolCallKey: row.tool_call_key } : {}),
    ...(row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    ...(row.conversation_path
      ? { conversationPath: row.conversation_path }
      : {}),
  } as QueueJob;
}
function createTables(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS jobs (${JOB_COLUMNS}); CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry_wait','sending','sent','failed','ambiguous')), payload_json TEXT, response_index INTEGER NOT NULL DEFAULT 0, payload_hash TEXT, host_unique_key TEXT, destination_type TEXT, destination_id TEXT, reply_message_id TEXT, cron_thread_id TEXT, external_message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_until TEXT, worker_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); DROP INDEX IF EXISTS deliveries_job; CREATE UNIQUE INDEX IF NOT EXISTS deliveries_host_unique ON deliveries(host_unique_key) WHERE host_unique_key IS NOT NULL; CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, status TEXT NOT NULL CHECK(status IN ('active','completed','dead_letter')), created_at TEXT NOT NULL, completed_at TEXT); CREATE TABLE IF NOT EXISTS dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, reason TEXT NOT NULL, payload_json TEXT, error TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status, next_attempt_at, lease_until, created_at); CREATE INDEX IF NOT EXISTS jobs_session_order ON jobs(session_id, sequence, status); CREATE INDEX IF NOT EXISTS deliveries_claim ON deliveries(status, next_attempt_at, lease_until, created_at); CREATE INDEX IF NOT EXISTS dead_letters_job ON dead_letters(job_id, created_at);`,
  );
}
const JOB_COLUMNS = `id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, payload_json TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('queued','retry_wait','claimed','running','completed','dead_letter')), claimed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10, next_attempt_at TEXT, lease_until TEXT, worker_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, claimed_at TEXT, started_at TEXT, heartbeat_at TEXT, exit_code INTEGER, termination TEXT, stop_reason TEXT, usage_json TEXT, timing_json TEXT, error_json TEXT, result_json TEXT, result_state TEXT CHECK(result_state IN ('succeeded','empty_response','non_retryable','max_retries','dead_letter')), terminal_reason TEXT, succeeded INTEGER NOT NULL DEFAULT 0, delivery_id TEXT, agents_snapshot_hash TEXT, memory_snapshot_hash TEXT, snapshot_hash TEXT, tool_call_key TEXT, workspace_path TEXT, conversation_path TEXT`;
function migrateOldJobs(db: Database.Database): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
    .get() as { sql?: string } | undefined;
  if (!row || (row.sql?.includes("result_json") && row.sql.includes("claimed")))
    return;
  const tables = ["deliveries", "idempotency_keys", "dead_letters"];
  db.pragma("foreign_keys = OFF");
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
  } catch (error) {
    db.pragma("foreign_keys = ON");
    throw error;
  }
  try {
    db.exec("ALTER TABLE jobs RENAME TO jobs_legacy");
    for (const table of tables) {
      if (
        db
          .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
          .get(table)
      ) {
        db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
      }
    }
    for (const index of [
      "jobs_claim",
      "jobs_idempotency",
      "deliveries_claim",
      "dead_letters_job",
    ]) {
      db.exec(`DROP INDEX IF EXISTS ${index}`);
    }
    createTables(db);
    db.exec(`INSERT INTO jobs(id,idempotency_key,payload_json,status,attempts,max_attempts,next_attempt_at,lease_until,worker_id,fencing_token,last_error,created_at,updated_at,completed_at,session_id,sequence,result_state,succeeded,terminal_reason)
      SELECT id,idempotency_key,payload_json,
        CASE WHEN status='running' THEN 'queued' ELSE status END,
        attempts,max_attempts,next_attempt_at,NULL,NULL,fencing_token,last_error,created_at,updated_at,completed_at,
        COALESCE(json_extract(payload_json,'$.sessionId'),''),
        ROW_NUMBER() OVER (PARTITION BY COALESCE(json_extract(payload_json,'$.sessionId'),'') ORDER BY created_at,id)-1,
        CASE WHEN status='completed' THEN 'succeeded' WHEN status='dead_letter' THEN 'dead_letter' ELSE NULL END,
        CASE WHEN status='completed' THEN 1 ELSE 0 END,
        CASE WHEN status='dead_letter' THEN 'dead_letter' ELSE NULL END
      FROM jobs_legacy`);
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='deliveries_legacy'",
        )
        .get()
    ) {
      db.exec(`INSERT INTO deliveries(id,job_id,status,payload_json,attempts,next_attempt_at,lease_until,worker_id,fencing_token,last_error,created_at,updated_at)
        SELECT id,job_id,status,payload_json,attempts,next_attempt_at,lease_until,worker_id,fencing_token,last_error,created_at,updated_at FROM deliveries_legacy`);
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='idempotency_keys_legacy'",
        )
        .get()
    ) {
      const columns = db
        .prepare("PRAGMA table_info(idempotency_keys_legacy)")
        .all() as Array<{ name: string }>;
      const completed = columns.some((column) => column.name === "completed_at")
        ? "completed_at"
        : "NULL";
      db.exec(
        `INSERT INTO idempotency_keys(key,job_id,status,created_at,completed_at) SELECT key,job_id,status,created_at,${completed} FROM idempotency_keys_legacy`,
      );
    }
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='dead_letters_legacy'",
        )
        .get()
    ) {
      db.exec(`INSERT INTO dead_letters(job_id,reason,payload_json,error,source,created_at)
        SELECT job_id,reason,payload_json,error,source,created_at FROM dead_letters_legacy`);
    }
    for (const table of [
      "jobs_legacy",
      "deliveries_legacy",
      "idempotency_keys_legacy",
      "dead_letters_legacy",
    ]) {
      db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0)
      throw new Error("queue migration foreign-key check failed");
    db.exec("COMMIT");
  } catch (error) {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
    throw error;
  } finally {
    db.pragma("foreign_keys = ON");
  }
}
export function configureRuntimeDb(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  migrateOldJobs(db);
  createTables(db);
  for (const column of [
    "response_index INTEGER NOT NULL DEFAULT 0",
    "payload_hash TEXT",
    "host_unique_key TEXT",
    "destination_type TEXT",
    "destination_id TEXT",
    "reply_message_id TEXT",
    "cron_thread_id TEXT",
    "external_message_id TEXT",
  ]) {
    try {
      db.exec(`ALTER TABLE deliveries ADD COLUMN ${column}`);
    } catch {}
  }
  db.exec(
    "DROP INDEX IF EXISTS deliveries_job; CREATE UNIQUE INDEX IF NOT EXISTS deliveries_host_unique ON deliveries(host_unique_key) WHERE host_unique_key IS NOT NULL; UPDATE deliveries SET response_index=0 WHERE response_index IS NULL; UPDATE deliveries SET host_unique_key=job_id || ':0' WHERE host_unique_key IS NULL;",
  );
  try {
    db.exec("ALTER TABLE jobs ADD COLUMN claimed INTEGER NOT NULL DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE idempotency_keys ADD COLUMN completed_at TEXT");
  } catch {}
  db.prepare(
    "INSERT INTO schema_meta(key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(QUEUE_SCHEMA_VERSION));
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
function syntheticCompleted(
  payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">,
  key: string,
): QueueJob {
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
    sequence: 0,
    terminalState: "succeeded",
    succeeded: true,
  };
}
export class QueueRepository {
  readonly db: Database.Database;
  readonly workerId: string;
  constructor(
    dbOrPath?: Database.Database | string,
    workerId = `worker-${process.pid}-${randomUUID().slice(0, 8)}`,
  ) {
    this.db =
      typeof dbOrPath === "string" || dbOrPath === undefined
        ? openRuntimeDb(dbOrPath)
        : dbOrPath;
    configureRuntimeDb(this.db);
    this.workerId = workerId;
  }
  close(): void {
    this.db.close();
  }
  get(id: string): QueueJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
      | JobRow
      | undefined;
    return row ? parsePayload(row) : undefined;
  }
  findByIdempotencyKey(key: string): QueueJob | undefined {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE idempotency_key=?")
      .get(key) as JobRow | undefined;
    return row ? parsePayload(row) : undefined;
  }
  enqueue(
    payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">,
    options: { idempotencyKey?: string; maxAttempts?: number } = {},
  ): EnqueueResult {
    const key = options.idempotencyKey ?? payload.idempotencyKey;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (key) {
        const idem = this.db
          .prepare("SELECT key,job_id,status FROM idempotency_keys WHERE key=?")
          .get(key) as
          | { key: string; job_id: string | null; status: string }
          | undefined;
        if (idem) {
          const existing = idem.job_id ? this.get(idem.job_id) : undefined;
          this.db.exec("COMMIT");
          return {
            job: existing ?? syntheticCompleted(payload, key),
            inserted: false,
          };
        }
      }
      const id = `job-${randomUUID()}`;
      const timestamp = nowIso();
      const sequenceRow = this.db
        .prepare(
          "SELECT COALESCE(MAX(sequence),-1)+1 AS sequence FROM jobs WHERE session_id=?",
        )
        .get(payload.sessionId) as { sequence: number };
      const record = {
        id,
        retries: 0,
        ...payload,
        enqueuedAt: timestamp,
        ...(key ? { idempotencyKey: key } : {}),
      } as InboxMessage;
      this.db
        .prepare(
          `INSERT INTO jobs (id,idempotency_key,payload_json,session_id,sequence,status,attempts,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          key ?? null,
          JSON.stringify(record),
          payload.sessionId,
          sequenceRow.sequence,
          "queued",
          0,
          options.maxAttempts ?? 10,
          timestamp,
          timestamp,
        );
      if (key)
        this.db
          .prepare(
            "INSERT INTO idempotency_keys(key,job_id,status,created_at) VALUES(?,?,?,?)",
          )
          .run(key, id, "active", timestamp);
      const result = { job: this.get(id)!, inserted: true };
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  claim(
    workerId = this.workerId,
    leaseMs = 60_000,
    at = new Date(),
    excludeIds: ReadonlySet<string> = new Set(),
  ): ClaimedJob | undefined {
    const now = at.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const excluded = [...excludeIds];
      const excludedSql = excluded.length
        ? ` AND j.id NOT IN (${excluded.map(() => "?").join(",")})`
        : "";
      const eligible = `((j.status IN ('queued','retry_wait') AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?)) OR (j.status IN ('claimed','running') AND j.lease_until<=?))`;
      const exhausted = this.db
        .prepare(
          `SELECT j.* FROM jobs j WHERE ${eligible} AND j.attempts>=j.max_attempts${excludedSql}`,
        )
        .all(now, now, ...excluded) as JobRow[];
      for (const row of exhausted)
        this.deadLetterExhaustedInTransaction(row, "max_attempts");
      const row = this.db
        .prepare(
          `SELECT j.* FROM jobs j WHERE ${eligible} AND j.attempts<j.max_attempts${excludedSql} AND NOT EXISTS (SELECT 1 FROM jobs prior WHERE prior.session_id=j.session_id AND prior.sequence<j.sequence AND prior.status NOT IN ('completed','dead_letter')) ORDER BY j.created_at,j.sequence LIMIT 1`,
        )
        .get(now, now, ...excluded) as JobRow | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const token = row.fencing_token + 1;
      const leaseUntil = new Date(
        at.getTime() + Math.max(1, leaseMs),
      ).toISOString();
      const result = this.db
        .prepare(
          `UPDATE jobs SET status='claimed',claimed=1,worker_id=?,lease_until=?,fencing_token=?,attempts=attempts+1,claimed_at=COALESCE(claimed_at,?),heartbeat_at=?,updated_at=? WHERE id=? AND fencing_token=? AND (status IN ('queued','retry_wait') OR (status IN ('claimed','running') AND lease_until<=?)) AND attempts<max_attempts`,
        )
        .run(
          workerId,
          leaseUntil,
          token,
          now,
          now,
          now,
          row.id,
          row.fencing_token,
          now,
        );
      if (result.changes !== 1) throw new Error(`claim race for job ${row.id}`);
      this.db.exec("COMMIT");
      const claimed = this.get(row.id);
      return claimed ? { job: claimed, fencingToken: token } : undefined;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  private fenced(
    id: string,
    token: number,
    update: Record<string, unknown>,
  ): void {
    const sets = Object.keys(update)
      .map((key) => `${key}=@${key}`)
      .join(",");
    const result = this.db
      .prepare(
        `UPDATE jobs SET ${sets},updated_at=@updated_at WHERE id=@id AND status IN ('claimed','running') AND fencing_token=@token`,
      )
      .run({ ...update, updated_at: nowIso(), id, token });
    if (result.changes !== 1)
      throw new Error(`stale fencing token for job ${id}`);
  }
  isFenced(id: string, token: number): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE id=? AND status IN ('claimed','running') AND fencing_token=?",
        )
        .get(id, token) !== undefined
    );
  }
  private updatePayload(
    id: string,
    token: number,
    patch: Partial<InboxMessage>,
  ): void {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    const payload = { ...job } as Record<string, unknown>;
    for (const key of [
      "status",
      "attempts",
      "maxAttempts",
      "nextAttemptAt",
      "leaseUntil",
      "workerId",
      "fencingToken",
      "lastError",
      "sequence",
      "succeeded",
      "terminalState",
      "resultJson",
      "deliveryId",
    ])
      delete payload[key];
    const sanitizedPatch = { ...patch } as Record<string, unknown>;
    for (const key of [
      "fencingToken",
      "workerId",
      "lastError",
      "status",
      "attempts",
      "maxAttempts",
      "nextAttemptAt",
      "leaseUntil",
    ])
      delete sanitizedPatch[key];
    Object.assign(payload, sanitizedPatch);
    this.fenced(id, token, { payload_json: JSON.stringify(payload) });
  }
  updateRunning(id: string, token: number, patch: Partial<InboxMessage>): void {
    this.updatePayload(id, token, patch);
  }
  markRunning(
    id: string,
    token: number,
    metadata: ExecutionMetadata = {},
  ): void {
    this.fenced(id, token, {
      status: "running",
      claimed: 0,
      started_at: metadata.startedAt ?? nowIso(),
      heartbeat_at: nowIso(),
      ...(metadata.exitCode !== undefined
        ? { exit_code: metadata.exitCode }
        : {}),
      ...(metadata.termination ? { termination: metadata.termination } : {}),
      ...(metadata.stopReason ? { stop_reason: metadata.stopReason } : {}),
      ...(metadata.timing !== undefined
        ? { timing_json: JSON.stringify(metadata.timing) }
        : {}),
      ...(metadata.usage !== undefined
        ? { usage_json: JSON.stringify(metadata.usage) }
        : {}),
      ...(metadata.agentsSnapshotHash
        ? { agents_snapshot_hash: metadata.agentsSnapshotHash }
        : {}),
      ...(metadata.memorySnapshotHash
        ? { memory_snapshot_hash: metadata.memorySnapshotHash }
        : {}),
      ...(metadata.snapshotHash
        ? { snapshot_hash: metadata.snapshotHash }
        : {}),
      ...(metadata.toolCallKey ? { tool_call_key: metadata.toolCallKey } : {}),
      ...(metadata.workspacePath
        ? { workspace_path: metadata.workspacePath }
        : {}),
      ...(metadata.conversationPath
        ? { conversation_path: metadata.conversationPath }
        : {}),
    });
  }
  freezeExecutionIdentity(
    id: string,
    token: number,
    identity: {
      snapshotHash?: string;
      toolCallKey?: string;
      agentsSnapshotContent?: string;
      memorySnapshotContent?: string;
      agentsSnapshotPresent?: boolean;
      memorySnapshotPresent?: boolean;
      snapshotPresent?: boolean;
    } = {},
  ): void {
    const snapshotHash = identity.snapshotHash ?? "phase2-absent-snapshot-v1";
    const toolCallKey =
      identity.toolCallKey ??
      createHash("sha256").update(`phase2-job:${id}`).digest("hex");
    const row = this.db
      .prepare(
        "SELECT payload_json FROM jobs WHERE id=? AND status IN ('claimed','running') AND fencing_token=?",
      )
      .get(id, token) as { payload_json: string } | undefined;
    if (!row) throw new Error(`stale fencing token for job ${id}`);
    const payload = {
      ...(JSON.parse(row.payload_json) as Record<string, unknown>),
      ...(identity.agentsSnapshotContent !== undefined
        ? { agentsSnapshotContent: identity.agentsSnapshotContent }
        : {}),
      ...(identity.memorySnapshotContent !== undefined
        ? { memorySnapshotContent: identity.memorySnapshotContent }
        : {}),
      ...(identity.agentsSnapshotPresent !== undefined
        ? { agentsSnapshotPresent: identity.agentsSnapshotPresent }
        : {}),
      ...(identity.memorySnapshotPresent !== undefined
        ? { memorySnapshotPresent: identity.memorySnapshotPresent }
        : {}),
      ...(identity.snapshotPresent !== undefined
        ? { snapshotPresent: identity.snapshotPresent }
        : {}),
    };
    const result = this.db
      .prepare(
        "UPDATE jobs SET payload_json=?,snapshot_hash=COALESCE(snapshot_hash,?),tool_call_key=COALESCE(tool_call_key,?),updated_at=? WHERE id=? AND status IN ('claimed','running') AND fencing_token=?",
      )
      .run(
        JSON.stringify(payload),
        snapshotHash,
        toolCallKey,
        nowIso(),
        id,
        token,
      );
    if (result.changes !== 1)
      throw new Error(`stale fencing token for job ${id}`);
  }
  commitResult(
    id: string,
    token: number,
    result: unknown,
    options: {
      empty?: boolean;
      metadata?: ExecutionMetadata;
      deliveryPayload?: unknown;
    } = {},
  ): DeliveryRow {
    const at = nowIso();
    const resultJson =
      typeof result === "string"
        ? JSON.stringify(result)
        : JSON.stringify(result ?? null);
    const state: TerminalState = options.empty ? "empty_response" : "succeeded";
    const m = options.metadata ?? {};
    const hasDeliveryMeta = options.deliveryPayload !== undefined;
    const deliveryMeta = (
      options.deliveryPayload && typeof options.deliveryPayload === "object"
        ? options.deliveryPayload
        : {}
    ) as Record<string, unknown>;
    const chunks = options.empty
      ? []
      : splitMessage(
          typeof result === "string" ? result : JSON.stringify(result ?? null),
        );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT idempotency_key FROM jobs WHERE id=? AND status IN ('claimed','running') AND fencing_token=?",
        )
        .get(id, token) as { idempotency_key: string | null } | undefined;
      if (!row) throw new Error(`stale fencing token for job ${id}`);
      const changed = this.db
        .prepare(
          `UPDATE jobs SET status='completed',lease_until=NULL,worker_id=NULL,completed_at=?,result_json=?,result_state=?,succeeded=?,delivery_id=NULL,exit_code=COALESCE(?,exit_code),termination=COALESCE(?,termination),stop_reason=COALESCE(?,stop_reason),usage_json=COALESCE(?,usage_json),timing_json=COALESCE(?,timing_json),agents_snapshot_hash=COALESCE(?,agents_snapshot_hash),memory_snapshot_hash=COALESCE(?,memory_snapshot_hash),snapshot_hash=COALESCE(?,snapshot_hash),tool_call_key=COALESCE(?,tool_call_key),workspace_path=COALESCE(?,workspace_path),conversation_path=COALESCE(?,conversation_path) WHERE id=? AND status IN ('claimed','running') AND fencing_token=?`,
        )
        .run(
          at,
          resultJson,
          state,
          options.empty ? 0 : 1,
          m.exitCode ?? null,
          m.termination ?? null,
          m.stopReason ?? null,
          m.usage === undefined ? null : JSON.stringify(m.usage),
          m.timing === undefined ? null : JSON.stringify(m.timing),
          m.agentsSnapshotHash ?? m.snapshotHash ?? null,
          m.memorySnapshotHash ?? null,
          m.snapshotHash ?? null,
          m.toolCallKey ?? null,
          m.workspacePath ?? null,
          m.conversationPath ?? null,
          id,
          token,
        );
      if (changed.changes !== 1)
        throw new Error(`stale fencing token for job ${id}`);
      let first: DeliveryRow | undefined;
      for (let index = 0; index < chunks.length; index += 1) {
        const content = chunks[index]!;
        const payload = hasDeliveryMeta
          ? JSON.stringify({ ...deliveryMeta, content, responseIndex: index })
          : resultJson;
        const payloadHash = createHash("sha256").update(payload).digest("hex");
        const deliveryId = `delivery-${randomUUID()}`;
        const hostKey = `${id}:${index}`;
        this.db
          .prepare(
            "INSERT INTO deliveries(id,job_id,status,payload_json,response_index,payload_hash,host_unique_key,destination_type,destination_id,reply_message_id,cron_thread_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            deliveryId,
            id,
            "pending",
            payload,
            index,
            payloadHash,
            hostKey,
            deliveryMeta.destinationType ?? "channel",
            deliveryMeta.destinationId ?? null,
            deliveryMeta.replyMessageId ?? null,
            deliveryMeta.cronThreadId ?? null,
            at,
            at,
          );
        first ??= {
          id: deliveryId,
          jobId: id,
          status: "pending",
          payloadJson: payload,
          createdAt: at,
          responseIndex: index,
          payloadHash,
          hostUniqueKey: hostKey,
        };
      }
      if (first)
        this.db
          .prepare("UPDATE jobs SET delivery_id=? WHERE id=?")
          .run(first.id, id);
      if (row.idempotency_key)
        this.db
          .prepare(
            "UPDATE idempotency_keys SET status='completed',completed_at=? WHERE key=?",
          )
          .run(at, row.idempotency_key);
      this.db.exec("COMMIT");
      return (
        first ?? {
          id: "",
          jobId: id,
          status: "sent",
          payloadJson: null,
          createdAt: at,
        }
      );
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  heartbeat(id: string, token: number, leaseMs = 60_000): void {
    this.fenced(id, token, {
      lease_until: new Date(Date.now() + Math.max(1, leaseMs)).toISOString(),
      heartbeat_at: nowIso(),
    });
  }
  renew(id: string, token: number, leaseMs = 60_000): void {
    this.heartbeat(id, token, leaseMs);
  }
  complete(id: string, token: number): void {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    if (job.executionState === "claimed") this.markRunning(id, token);
    if (job.resultJson === undefined)
      this.commitResult(id, token, "", { empty: true });
  }
  retry(
    id: string,
    token: number,
    error: unknown,
    delayMs = 1000,
    payloadPatch?: Partial<InboxMessage>,
    metadata: ExecutionMetadata = {},
  ): void {
    const message = errorMessage(error);
    this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT attempts,max_attempts,result_json,payload_json FROM jobs WHERE id=?",
        )
        .get(id) as
        | {
            attempts: number;
            max_attempts: number;
            result_json: string | null;
            payload_json: string;
          }
        | undefined;
      if (!row) throw new Error(`unknown job ${id}`);
      if (row.result_json !== null) return;
      const payload = JSON.parse(row.payload_json) as InboxMessage;
      this.updatePayload(id, token, {
        ...payloadPatch,
        retries: (payload.retries ?? 0) + 1,
      });
      if (row.attempts >= row.max_attempts) {
        this.deadLetterInTransaction(
          id,
          token,
          "max_attempts",
          message,
          "queue",
          metadata,
        );
        return;
      }
      this.fenced(id, token, {
        status: "retry_wait",
        next_attempt_at: new Date(
          Date.now() + Math.max(0, delayMs),
        ).toISOString(),
        lease_until: null,
        worker_id: null,
        last_error: message,
        error_json: JSON.stringify({ message, error }),
        ...(metadata.exitCode !== undefined
          ? { exit_code: metadata.exitCode }
          : {}),
        ...(metadata.termination ? { termination: metadata.termination } : {}),
        ...(metadata.stopReason ? { stop_reason: metadata.stopReason } : {}),
        ...(metadata.usage !== undefined
          ? { usage_json: JSON.stringify(metadata.usage) }
          : {}),
        ...(metadata.timing !== undefined
          ? { timing_json: JSON.stringify(metadata.timing) }
          : {}),
        ...(metadata.agentsSnapshotHash
          ? { agents_snapshot_hash: metadata.agentsSnapshotHash }
          : {}),
        ...(metadata.memorySnapshotHash
          ? { memory_snapshot_hash: metadata.memorySnapshotHash }
          : {}),
        ...(metadata.snapshotHash
          ? { snapshot_hash: metadata.snapshotHash }
          : {}),
        ...(metadata.toolCallKey
          ? { tool_call_key: metadata.toolCallKey }
          : {}),
        ...(metadata.workspacePath
          ? { workspace_path: metadata.workspacePath }
          : {}),
        ...(metadata.conversationPath
          ? { conversation_path: metadata.conversationPath }
          : {}),
      });
    })();
  }
  private deadLetterInTransaction(
    id: string,
    token: number,
    reason: string,
    error?: string,
    source = "queue",
    metadata: ExecutionMetadata = {},
  ): void {
    const row = this.db
      .prepare("SELECT payload_json,idempotency_key FROM jobs WHERE id=?")
      .get(id) as
      | { payload_json: string; idempotency_key: string | null }
      | undefined;
    this.fenced(id, token, {
      status: "dead_letter",
      lease_until: null,
      worker_id: null,
      next_attempt_at: null,
      last_error: error ?? reason,
      terminal_reason: reason,
      result_state: reason === "max_attempts" ? "max_retries" : "non_retryable",
      error_json: JSON.stringify({ message: error ?? reason, error }),
      ...(metadata.exitCode !== undefined
        ? { exit_code: metadata.exitCode }
        : {}),
      ...(metadata.termination ? { termination: metadata.termination } : {}),
      ...(metadata.stopReason ? { stop_reason: metadata.stopReason } : {}),
      ...(metadata.usage !== undefined
        ? { usage_json: JSON.stringify(metadata.usage) }
        : {}),
      ...(metadata.timing !== undefined
        ? { timing_json: JSON.stringify(metadata.timing) }
        : {}),
      ...(metadata.agentsSnapshotHash
        ? { agents_snapshot_hash: metadata.agentsSnapshotHash }
        : {}),
      ...(metadata.memorySnapshotHash
        ? { memory_snapshot_hash: metadata.memorySnapshotHash }
        : {}),
      ...(metadata.snapshotHash
        ? { snapshot_hash: metadata.snapshotHash }
        : {}),
      ...(metadata.toolCallKey ? { tool_call_key: metadata.toolCallKey } : {}),
      ...(metadata.workspacePath
        ? { workspace_path: metadata.workspacePath }
        : {}),
      ...(metadata.conversationPath
        ? { conversation_path: metadata.conversationPath }
        : {}),
    });
    this.db
      .prepare(
        "INSERT INTO dead_letters(job_id,reason,payload_json,error,source,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        id,
        reason,
        row?.payload_json ?? null,
        error ?? null,
        source,
        nowIso(),
      );
    if (row?.idempotency_key)
      this.db
        .prepare("UPDATE idempotency_keys SET status='dead_letter' WHERE key=?")
        .run(row.idempotency_key);
  }
  private deadLetterExhaustedInTransaction(row: JobRow, reason: string): void {
    const at = nowIso();
    const error = row.last_error ?? reason;
    const result = this.db
      .prepare(
        "UPDATE jobs SET status='dead_letter',lease_until=NULL,worker_id=NULL,next_attempt_at=NULL,last_error=?,terminal_reason=?,result_state='max_retries',updated_at=? WHERE id=? AND status=? AND attempts>=max_attempts",
      )
      .run(error, reason, at, row.id, row.status);
    if (result.changes !== 1) return;
    this.db
      .prepare(
        "INSERT INTO dead_letters(job_id,reason,payload_json,error,source,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(row.id, reason, row.payload_json, error, "queue", at);
    if (row.idempotency_key)
      this.db
        .prepare("UPDATE idempotency_keys SET status='dead_letter' WHERE key=?")
        .run(row.idempotency_key);
  }
  deadLetter(
    id: string,
    token: number,
    reason: string,
    error?: string,
    metadata: ExecutionMetadata = {},
  ): void {
    this.db.transaction(() =>
      this.deadLetterInTransaction(id, token, reason, error, "queue", metadata),
    )();
  }
  recoverExpired(at = new Date()): number {
    const now = at.toISOString();
    const rows = this.db
      .prepare(
        "SELECT * FROM jobs WHERE status IN ('claimed','running') AND lease_until<=?",
      )
      .all(now) as JobRow[];
    let count = 0;
    this.db.transaction(() => {
      for (const row of rows) {
        const result = this.db
          .prepare(
            "UPDATE jobs SET status='retry_wait',claimed=0,worker_id=NULL,lease_until=NULL,next_attempt_at=?,last_error=COALESCE(last_error,'lease expired'),terminal_reason=NULL,updated_at=? WHERE id=? AND status IN ('claimed','running') AND fencing_token=?",
          )
          .run(now, now, row.id, row.fencing_token);
        count += result.changes;
      }
    })();
    return count;
  }
  requeueExpired(at = new Date()): number {
    return this.recoverExpired(at);
  }
  getDelivery(jobId: string): DeliveryRow | undefined {
    const row = this.db
      .prepare(
        "SELECT id,job_id,status,payload_json,created_at,response_index,payload_hash,host_unique_key,destination_type,destination_id,reply_message_id,cron_thread_id,external_message_id,lease_until,worker_id,fencing_token,attempts,next_attempt_at,last_error FROM deliveries WHERE job_id=? ORDER BY response_index LIMIT 1",
      )
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? this.parseDelivery(row) : undefined;
  }
  listDeliveries(status?: DeliveryStatus): DeliveryRow[] {
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT id,job_id,status,payload_json,created_at,response_index,payload_hash,host_unique_key,destination_type,destination_id,reply_message_id,cron_thread_id,external_message_id,lease_until,worker_id,fencing_token,attempts,next_attempt_at,last_error FROM deliveries WHERE status=? ORDER BY job_id,response_index",
            )
            .all(status)
        : this.db
            .prepare(
              "SELECT id,job_id,status,payload_json,created_at,response_index,payload_hash,host_unique_key,destination_type,destination_id,reply_message_id,cron_thread_id,external_message_id,lease_until,worker_id,fencing_token,attempts,next_attempt_at,last_error FROM deliveries ORDER BY job_id,response_index",
            )
            .all()
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => this.parseDelivery(row));
  }
  private parseDelivery(row: Record<string, unknown>): DeliveryRow {
    return {
      id: String(row.id),
      jobId: String(row.job_id),
      status: row.status as DeliveryStatus,
      payloadJson: row.payload_json as string | null,
      createdAt: String(row.created_at),
      responseIndex: Number(row.response_index ?? 0),
      ...(row.payload_hash ? { payloadHash: String(row.payload_hash) } : {}),
      ...(row.host_unique_key
        ? { hostUniqueKey: String(row.host_unique_key) }
        : {}),
      ...(row.destination_type
        ? { destinationType: String(row.destination_type) }
        : {}),
      ...(row.destination_id
        ? { destinationId: String(row.destination_id) }
        : {}),
      ...(row.reply_message_id
        ? { replyMessageId: String(row.reply_message_id) }
        : {}),
      ...(row.cron_thread_id
        ? { cronThreadId: String(row.cron_thread_id) }
        : {}),
      ...(row.external_message_id
        ? { externalMessageId: String(row.external_message_id) }
        : {}),
      ...(row.lease_until ? { leaseUntil: String(row.lease_until) } : {}),
      ...(row.worker_id ? { workerId: String(row.worker_id) } : {}),
      fencingToken: Number(row.fencing_token ?? 0),
      attempts: Number(row.attempts ?? 0),
      ...(row.next_attempt_at
        ? { nextAttemptAt: String(row.next_attempt_at) }
        : {}),
      ...(row.last_error ? { lastError: String(row.last_error) } : {}),
    };
  }
  claimDelivery(
    workerId = this.workerId,
    leaseMs = 60_000,
    at = new Date(),
  ): DeliveryClaim | undefined {
    const now = at.toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE deliveries SET status='ambiguous',lease_until=NULL,worker_id=NULL,last_error=COALESCE(last_error,'sending lease expired'),updated_at=? WHERE status='sending' AND lease_until<=?",
        )
        .run(now, now);
      const row = this.db
        .prepare(
          "SELECT candidate.* FROM deliveries AS candidate WHERE candidate.status IN ('pending','retry_wait') AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at<=?) AND NOT EXISTS (SELECT 1 FROM deliveries AS predecessor WHERE predecessor.job_id=candidate.job_id AND predecessor.response_index<candidate.response_index AND predecessor.status NOT IN ('sent','failed','ambiguous')) ORDER BY candidate.created_at,candidate.response_index LIMIT 1",
        )
        .get(now) as Record<string, unknown> | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const token = Number(row.fencing_token ?? 0) + 1;
      const changed = this.db
        .prepare(
          "UPDATE deliveries SET status='sending',attempts=attempts+1,lease_until=?,worker_id=?,fencing_token=?,updated_at=? WHERE id=? AND status IN ('pending','retry_wait')",
        )
        .run(
          new Date(at.getTime() + Math.max(1, leaseMs)).toISOString(),
          workerId,
          token,
          now,
          row.id,
        );
      if (changed.changes !== 1) {
        this.db.exec("ROLLBACK");
        return undefined;
      }
      const claimed = {
        ...row,
        status: "sending",
        lease_until: new Date(
          at.getTime() + Math.max(1, leaseMs),
        ).toISOString(),
        worker_id: workerId,
        fencing_token: token,
        attempts: Number(row.attempts ?? 0) + 1,
      };
      this.db.exec("COMMIT");
      return { row: this.parseDelivery(claimed), fencingToken: token };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  updateDelivery(
    id: string,
    token: number,
    status: DeliveryStatus,
    fields: {
      externalMessageId?: string;
      cronThreadId?: string;
      error?: string;
      retryAt?: string;
    } = {},
  ): void {
    const sets = ["status=@status", "updated_at=@updated_at"];
    const params: Record<string, unknown> = {
      id,
      token,
      status,
      updated_at: nowIso(),
    };
    if (fields.externalMessageId !== undefined) {
      sets.push("external_message_id=@externalMessageId");
      params.externalMessageId = fields.externalMessageId;
    }
    if (fields.cronThreadId !== undefined) {
      sets.push("cron_thread_id=@cronThreadId");
      params.cronThreadId = fields.cronThreadId;
    }
    if (fields.error !== undefined) {
      sets.push("last_error=@error");
      params.error = fields.error;
    }
    if (fields.retryAt !== undefined) {
      sets.push("next_attempt_at=@retryAt");
      params.retryAt = fields.retryAt;
    }
    if (
      status === "sent" ||
      status === "ambiguous" ||
      status === "failed" ||
      status === "retry_wait"
    )
      sets.push("lease_until=NULL", "worker_id=NULL");
    const changed = this.db
      .prepare(
        `UPDATE deliveries SET ${sets.join(",")} WHERE id=@id AND status='sending' AND fencing_token=@token`,
      )
      .run(params);
    if (changed.changes !== 1)
      throw new Error(`stale fencing token for delivery ${id}`);
  }
  resolveAmbiguousDelivery(
    id: string,
    resolution: "retry" | "sent" | "failed",
    externalMessageId?: string,
  ): void {
    const status: DeliveryStatus =
      resolution === "retry" ? "retry_wait" : resolution;
    this.db
      .prepare(
        "UPDATE deliveries SET status=?,next_attempt_at=?,external_message_id=COALESCE(?,external_message_id),lease_until=NULL,worker_id=NULL,last_error=NULL,updated_at=? WHERE id=? AND status='ambiguous'",
      )
      .run(
        status,
        resolution === "retry" ? nowIso() : null,
        externalMessageId ?? null,
        nowIso(),
        id,
      );
  }
  setDeliveryThread(id: string, cronThreadId: string): void;
  setDeliveryThread(id: string, token: number, cronThreadId: string): void;
  setDeliveryThread(
    id: string,
    tokenOrThread: number | string,
    maybeThread?: string,
  ): void {
    if (typeof tokenOrThread === "string") {
      this.db
        .prepare(
          "UPDATE deliveries SET cron_thread_id=?,updated_at=? WHERE job_id=? AND status IN ('pending','retry_wait','sending')",
        )
        .run(tokenOrThread, nowIso(), id);
      return;
    }
    const changed = this.db
      .prepare(
        "UPDATE deliveries SET cron_thread_id=?,updated_at=? WHERE id=? AND status='sending' AND fencing_token=?",
      )
      .run(maybeThread, nowIso(), id, tokenOrThread);
    if (changed.changes !== 1)
      throw new Error(`stale fencing token for delivery ${id}`);
  }
  getIdempotencyRecord(key: string): IdempotencyRecord | undefined {
    return this.db
      .prepare(
        "SELECT key,job_id as jobId,status FROM idempotency_keys WHERE key=?",
      )
      .get(key) as IdempotencyRecord | undefined;
  }
  listRssStatePaths(): string[] {
    const paths = new Set<string>();
    for (const row of this.db
      .prepare("SELECT payload_json FROM jobs")
      .all() as Array<{ payload_json: string }>) {
      try {
        const value = JSON.parse(row.payload_json) as {
          rssStatePath?: unknown;
        };
        if (
          typeof value.rssStatePath === "string" &&
          value.rssStatePath.length > 0
        )
          paths.add(value.rssStatePath);
      } catch {}
    }
    return [...paths];
  }
  recordDeadLetter(input: {
    jobId?: string;
    reason: string;
    payloadJson?: string | null;
    error?: string;
    source?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO dead_letters(job_id,reason,payload_json,error,source,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(
        input.jobId ?? null,
        input.reason,
        input.payloadJson ?? null,
        input.error ?? null,
        input.source ?? "queue",
        nowIso(),
      );
  }
  list(status?: JobStatus): QueueJob[] {
    const rows = (
      status
        ? this.db
            .prepare(
              "SELECT * FROM jobs WHERE status=? ORDER BY created_at,sequence",
            )
            .all(status)
        : this.db
            .prepare("SELECT * FROM jobs ORDER BY created_at,sequence")
            .all()
    ) as JobRow[];
    return rows.map(parsePayload);
  }
  listIdempotencyKeys(): Array<{
    key: string;
    jobId: string | null;
    status: string;
  }> {
    return this.db
      .prepare(
        "SELECT key,job_id as jobId,status FROM idempotency_keys ORDER BY key",
      )
      .all() as Array<{ key: string; jobId: string | null; status: string }>;
  }
}
let defaultRepository: QueueRepository | undefined;
export function getQueueRepository(): QueueRepository {
  return (defaultRepository ??= new QueueRepository());
}
export function closeQueueRepository(): void {
  defaultRepository?.close();
  defaultRepository = undefined;
}
