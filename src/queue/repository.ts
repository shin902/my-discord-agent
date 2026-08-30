import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { splitMessage } from "../utils/splitMessage.js";
import { type InboxMessage, normalizeInboxMessagePayload } from "./types.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const DEFAULT_RUNTIME_DB_PATH = path.join(ROOT, "data/runtime.sqlite");
export const QUEUE_SCHEMA_VERSION = 5;
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
export interface FailAttemptOptions {
  /** Optional patch merged into the job's payload_json before the retry is scheduled. */
  payloadPatch?: Partial<InboxMessage>;
  /** Optional execution metadata written to dedicated SQL columns (exit_code, timing_json, ...). */
  metadata?: ExecutionMetadata;
}
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
  systemPromptSnapshotHash?: string;
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
//
// Claimed-state semantics.
//
// Three representations coexist and are intentionally kept consistent:
//
// 1. DB status='claimed' is the canonical, behavior-driving state. claim()
//    moves queued/retry_wait rows here; markRunning() advances the row to
//    'running' and completion/retry/dead-letter/fencing/recovery predicates
//    all key off `status IN ('claimed','running')`.
// 2. DB `claimed` INTEGER is a legacy duplicate column from the pre-durable
//    schema. It is written in lock-step with the state machine (claim -> 1,
//    markRunning/recoverExpired -> 0) but is never read for behavior.
//    jobsTableIsLegacy() detects pre-durable tables by the presence of this
//    column, and removing it would require a schema-version bump plus a table
//    rebuild for stores already stamped at the current version, so it is
//    retained as a write-compatible legacy mirror.
// 3. TS executionState/status is a read-only projection computed inside
//    parsePayload: DB 'claimed' surfaces as status 'running' with
//    executionState 'claimed'; DB 'running' surfaces as status 'running' with
//    executionState 'running'. It is never persisted; complete() consumes it
//    to decide whether a freshly claimed job still needs markRunning().
//
// DB status is therefore the single canonical persisted state; executionState
// is a derived view; the `claimed` integer is a legacy duplicate that remains
// only for migration-shape compatibility.

export interface ClaimedJob {
  job: QueueJob;
  fencingToken: number;
}
interface ExecutionMetadataField {
  /** ExecutionMetadata field. */
  field: keyof ExecutionMetadata;
  /** SQL column that durably persists the field. */
  column: string;
  /** fenced() SET-clause value: undefined means "omit" so undefined never overwrites. */
  setValue: (metadata: ExecutionMetadata) => unknown;
  /** commitResult COALESCE value; NULL degrades to "keep the stored value". */
  coalesceValue: (metadata: ExecutionMetadata) => unknown;
}
// The single ExecutionMetadata -> SQL-column mapping shared by markRunning,
// commitResult, retry and deadLetterInTransaction. The two emitters below
// reproduce the historical per-method semantics without per-method duplication:
//
// - metadataSetColumns (fenced() SET clauses): undefined fields are omitted
//   entirely so a partial metadata object cannot clobber what the previous
//   attempt stored; an explicit null is still written for exitCode and the
//   usage/timing JSON literals; string destinations update only on truthy
//   values (historical truthiness checks).
// - metadataCoalesceValues/Assignments (commitResult): every field degrades to
//   COALESCE(?,column), i.e. both undefined and explicit null preserve the
//   stored value, except usage/timing which keep writing the JSON literal
//   "null" for an explicit null exactly as before.
const EXECUTION_METADATA_FIELDS: readonly ExecutionMetadataField[] = [
  {
    field: "exitCode",
    column: "exit_code",
    setValue: (m) => (m.exitCode !== undefined ? m.exitCode : undefined),
    coalesceValue: (m) => m.exitCode ?? null,
  },
  {
    field: "termination",
    column: "termination",
    setValue: (m) => m.termination || undefined,
    coalesceValue: (m) => m.termination ?? null,
  },
  {
    field: "stopReason",
    column: "stop_reason",
    setValue: (m) => m.stopReason || undefined,
    coalesceValue: (m) => m.stopReason ?? null,
  },
  {
    field: "usage",
    column: "usage_json",
    setValue: (m) =>
      m.usage !== undefined ? JSON.stringify(m.usage) : undefined,
    coalesceValue: (m) =>
      m.usage === undefined ? null : JSON.stringify(m.usage),
  },
  {
    field: "timing",
    column: "timing_json",
    setValue: (m) =>
      m.timing !== undefined ? JSON.stringify(m.timing) : undefined,
    coalesceValue: (m) =>
      m.timing === undefined ? null : JSON.stringify(m.timing),
  },
  {
    field: "systemPromptSnapshotHash",
    // Keep the deployed column name as a storage compatibility boundary.
    column: "agents_snapshot_hash",
    setValue: (m) => m.systemPromptSnapshotHash || undefined,
    // commitResult historically fell back from systemPromptSnapshotHash to
    // snapshotHash; keep that method-specific collapse here.
    coalesceValue: (m) => m.systemPromptSnapshotHash ?? m.snapshotHash ?? null,
  },
  {
    field: "memorySnapshotHash",
    column: "memory_snapshot_hash",
    setValue: (m) => m.memorySnapshotHash || undefined,
    coalesceValue: (m) => m.memorySnapshotHash ?? null,
  },
  {
    field: "snapshotHash",
    column: "snapshot_hash",
    setValue: (m) => m.snapshotHash || undefined,
    coalesceValue: (m) => m.snapshotHash ?? null,
  },
  {
    field: "toolCallKey",
    column: "tool_call_key",
    setValue: (m) => m.toolCallKey || undefined,
    coalesceValue: (m) => m.toolCallKey ?? null,
  },
  {
    field: "workspacePath",
    column: "workspace_path",
    setValue: (m) => m.workspacePath || undefined,
    coalesceValue: (m) => m.workspacePath ?? null,
  },
  {
    field: "conversationPath",
    column: "conversation_path",
    setValue: (m) => m.conversationPath || undefined,
    coalesceValue: (m) => m.conversationPath ?? null,
  },
];
/** fenced() SET-clause entries; undefined/empty entries are omitted so a partial metadata object never overwrites previously stored columns. */
function metadataSetColumns(
  metadata: ExecutionMetadata,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const mapping of EXECUTION_METADATA_FIELDS) {
    const value = mapping.setValue(metadata);
    if (value !== undefined) updates[mapping.column] = value;
  }
  return updates;
}
/** `column=COALESCE(?,column)` assignment list in canonical metadata column order. */
function metadataCoalesceAssignments(): string {
  return EXECUTION_METADATA_FIELDS.map(
    (mapping) => `${mapping.column}=COALESCE(?,${mapping.column})`,
  ).join(",");
}
/** commitResult positional values aligned with metadataCoalesceAssignments(). */
function metadataCoalesceValues(metadata: ExecutionMetadata): unknown[] {
  return EXECUTION_METADATA_FIELDS.map((mapping) =>
    mapping.coalesceValue(metadata),
  );
}

// Rollback sentinel for the write-transaction helper below. claimDelivery uses
// it to undo a transaction whose claim lost the race *without* treating that as
// an application error (the historical `ROLLBACK; return undefined` path).
const TRANSACTION_ROLLBACK = Symbol("queue.transaction.rollback");

export interface EnqueueResult {
  job: QueueJob;
  inserted: boolean;
}

export interface ShadowJobAdmission {
  payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">;
  options?: { idempotencyKey?: string; maxAttempts?: number };
}

export interface BotTaskSessionEnqueueResult {
  session: BotTaskSession;
  enqueue: EnqueueResult;
}

export interface BotTaskSession {
  sessionId: string;
  handle: string;
  groupName: string;
  botId: string;
  createdAt: string;
  lastUsedAt: string;
  preview: string;
}

export interface BotTaskSessionAdmission {
  jobId: string;
  sessionId: string;
  sequence: number;
}

export type BotTaskSessionPayload = Omit<
  InboxMessage,
  "id" | "retries" | "enqueuedAt" | "sessionId"
>;

export interface CreateBotTaskSessionInput {
  sessionId: string;
  handle: string;
  groupName: string;
  botId: string;
  sourceKey?: string;
  createdAt: string;
  preview: string;
}

interface BotTaskSessionRow {
  session_id: string;
  handle: string;
  group_name: string;
  bot_id: string;
  channel_id: string;
  created_at: string;
  last_used_at: string;
  preview: string;
}

function parseBotTaskSession(row: BotTaskSessionRow): BotTaskSession {
  return {
    sessionId: row.session_id,
    handle: row.handle,
    groupName: row.group_name,
    botId: row.bot_id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    preview: row.preview,
  };
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
function compareSnowflakeIds(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
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
  const payload = normalizeInboxMessagePayload(
    JSON.parse(row.payload_json) as InboxMessage,
  );
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
      ? { systemPromptSnapshotHash: row.agents_snapshot_hash }
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
interface SchemaMigration {
  version: number;
  summary: string;
  up: (db: Database.Database) => void;
}

/** Columns the durable delivery schema needs beyond the legacy deliveries table. */
const DELIVERY_UPGRADE_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "response_index", ddl: "response_index INTEGER NOT NULL DEFAULT 0" },
  { name: "payload_hash", ddl: "payload_hash TEXT" },
  { name: "host_unique_key", ddl: "host_unique_key TEXT" },
  { name: "destination_type", ddl: "destination_type TEXT" },
  { name: "destination_id", ddl: "destination_id TEXT" },
  { name: "reply_message_id", ddl: "reply_message_id TEXT" },
  { name: "cron_thread_id", ddl: "cron_thread_id TEXT" },
  { name: "external_message_id", ddl: "external_message_id TEXT" },
];

function createBaseTables(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS jobs (${JOB_COLUMNS}); CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','retry_wait','sending','sent','failed','ambiguous')), payload_json TEXT, response_index INTEGER NOT NULL DEFAULT 0, payload_hash TEXT, host_unique_key TEXT, destination_type TEXT, destination_id TEXT, reply_message_id TEXT, cron_thread_id TEXT, external_message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_until TEXT, worker_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS idempotency_keys (key TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, status TEXT NOT NULL CHECK(status IN ('active','completed','dead_letter')), created_at TEXT NOT NULL, completed_at TEXT); CREATE TABLE IF NOT EXISTS dead_letters (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL, reason TEXT NOT NULL, payload_json TEXT, error TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS jobs_claim ON jobs(status, next_attempt_at, lease_until, created_at); CREATE INDEX IF NOT EXISTS jobs_session_order ON jobs(session_id, sequence, status); CREATE INDEX IF NOT EXISTS deliveries_claim ON deliveries(status, next_attempt_at, lease_until, created_at); CREATE INDEX IF NOT EXISTS dead_letters_job ON dead_letters(job_id, created_at);`,
  );
}
const JOB_COLUMNS = `id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, payload_json TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('queued','retry_wait','claimed','running','completed','dead_letter')), claimed INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 10, next_attempt_at TEXT, lease_until TEXT, worker_id TEXT, fencing_token INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, claimed_at TEXT, started_at TEXT, heartbeat_at TEXT, exit_code INTEGER, termination TEXT, stop_reason TEXT, usage_json TEXT, timing_json TEXT, error_json TEXT, result_json TEXT, result_state TEXT CHECK(result_state IN ('succeeded','empty_response','non_retryable','max_retries','dead_letter')), terminal_reason TEXT, succeeded INTEGER NOT NULL DEFAULT 0, delivery_id TEXT, agents_snapshot_hash TEXT, memory_snapshot_hash TEXT, snapshot_hash TEXT, tool_call_key TEXT, workspace_path TEXT, conversation_path TEXT`;

function tableColumnNames(db: Database.Database, table: string): Set<string> {
  return new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    ).map((column) => column.name),
  );
}
function addMissingColumns(
  db: Database.Database,
  table: string,
  definitions: ReadonlyArray<{ name: string; ddl: string }>,
): void {
  const existing = tableColumnNames(db, table);
  for (const column of definitions) {
    if (!existing.has(column.name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.ddl}`);
    }
  }
}
/** Legacy pre-durable jobs tables lack either result_json or claimed. */
function jobsTableIsLegacy(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
    .get() as { sql?: string } | undefined;
  if (!row) return false;
  return !(row.sql?.includes("result_json") && row.sql.includes("claimed"));
}
function rebuildLegacyQueueSchema(db: Database.Database): void {
  // Rename legacy-era tables aside, rebuild the modern base schema and copy all
  // business data across with the historical status/state mapping. Runs inside the
  // migration driver's single IMMEDIATE transaction (foreign keys are disabled by
  // the driver for the rename/rebuild window), so a failure rolls the whole store
  // back and nothing is left half-migrated.
  const tables = ["deliveries", "idempotency_keys", "dead_letters"];
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
  createBaseTables(db);
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
      SELECT id,job_id,status,payload_json,attempts,next_attempt_at,lease_until,worker_id,fencing_token,last_error,created_at,updated_at
      FROM deliveries_legacy
      ORDER BY deliveries_legacy.rowid`);
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
}
function applyDurableRuntimeColumns(db: Database.Database): void {
  addMissingColumns(db, "deliveries", DELIVERY_UPGRADE_COLUMNS);
  addMissingColumns(db, "jobs", [
    { name: "claimed", ddl: "claimed INTEGER NOT NULL DEFAULT 0" },
  ]);
  addMissingColumns(db, "idempotency_keys", [
    { name: "completed_at", ddl: "completed_at TEXT" },
  ]);
  db.exec(
    "DROP INDEX IF EXISTS deliveries_job; CREATE UNIQUE INDEX IF NOT EXISTS deliveries_host_unique ON deliveries(host_unique_key) WHERE host_unique_key IS NOT NULL; UPDATE deliveries SET response_index=0 WHERE response_index IS NULL; UPDATE deliveries SET host_unique_key=job_id || ':0' WHERE host_unique_key IS NULL;",
  );
}
function createBotTaskSessionTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_task_sessions (
      session_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      group_name TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      -- Legacy physical column; delivery belongs to jobs/deliveries.
      channel_id TEXT NOT NULL,
      source_key TEXT UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      preview TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bot_task_sessions_owner
      ON bot_task_sessions(group_name, bot_id, last_used_at DESC);
  `);
}
function repairRuntimeSchema(db: Database.Database): void {
  if (jobsTableIsLegacy(db)) rebuildLegacyQueueSchema(db);
  applyDurableRuntimeColumns(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS discord_sync_cursors (scope_id TEXT PRIMARY KEY, last_message_id TEXT NOT NULL, updated_at TEXT NOT NULL, initialized INTEGER NOT NULL DEFAULT 1)",
  );
  addMissingColumns(db, "discord_sync_cursors", [
    { name: "initialized", ddl: "initialized INTEGER NOT NULL DEFAULT 1" },
  ]);
  createBotTaskSessionTable(db);
}
// Versioned schema migrations. Every step is idempotent; the value recorded in
// schema_meta('schema_version') gates which steps still need to run. Stores stamped
// at the current version still receive a shape-driven repair pass because the
// historical best-effort initializers stamped version 2 even when individual ALTER
// statements had silently failed.
const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 1,
    summary:
      "replace the legacy queue tables with the modern base runtime schema",
    up(db) {
      if (jobsTableIsLegacy(db)) rebuildLegacyQueueSchema(db);
      createBaseTables(db);
    },
  },
  {
    version: 2,
    summary: "apply the durable delivery and execution-state columns",
    up(db) {
      repairRuntimeSchema(db);
    },
  },
  {
    version: 3,
    summary: "add Discord history backfill cursors",
    up(db) {
      repairRuntimeSchema(db);
    },
  },
  {
    version: 4,
    summary: "persist empty Discord backfill initialization",
    up(db) {
      repairRuntimeSchema(db);
    },
  },
  {
    version: 5,
    summary: "add Bot task session metadata",
    up(db) {
      createBotTaskSessionTable(db);
    },
  },
];
// Fail fast when the versioned migration list and QUEUE_SCHEMA_VERSION drift
// apart (e.g. a future version bump without an appended migration step).
// Otherwise writeSchemaVersion would stamp stores at a version whose upgrade
// steps never ran, silently defeating the version gate.
if (
  SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]?.version !==
  QUEUE_SCHEMA_VERSION
) {
  throw new Error(
    `schema migration list out of sync: last step v${SCHEMA_MIGRATIONS[SCHEMA_MIGRATIONS.length - 1]?.version} vs QUEUE_SCHEMA_VERSION ${QUEUE_SCHEMA_VERSION}`,
  );
}
function readSchemaVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
    .get() as { value: string } | undefined;
  if (!row) return 0;
  const version = Number.parseInt(row.value, 10);
  return Number.isNaN(version) ? 0 : version;
}
function writeSchemaVersion(db: Database.Database): void {
  db.prepare(
    "INSERT INTO schema_meta(key,value) VALUES ('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(String(QUEUE_SCHEMA_VERSION));
}
function migrateRuntimeSchema(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
  );
  const from = readSchemaVersion(db);
  if (from > QUEUE_SCHEMA_VERSION) {
    throw new Error(
      `runtime database schema version ${from} exceeds supported version ${QUEUE_SCHEMA_VERSION}; refusing to migrate a newer store`,
    );
  }
  const pending = SCHEMA_MIGRATIONS.filter(
    (migration) => migration.version > from,
  );
  // All pending migrations plus the shape repairs run inside one IMMEDIATE
  // transaction so an interrupted or failing migration can never leave a
  // half-migrated store, and repeated initialization stays idempotent.
  // BEGIN IMMEDIATE is issued inside the guarded block: even when the write
  // lock cannot be acquired (another connection holds it past busy_timeout),
  // the finally clause below re-enables foreign_keys, so an injected database
  // is never left with FK enforcement disabled after a failed migration.
  db.pragma("foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const migration of pending) migration.up(db);
    if (pending.length === 0) repairRuntimeSchema(db);
    writeSchemaVersion(db);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) {
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
  migrateRuntimeSchema(db);
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
/** Column projection shared by delivery reads (getDelivery / listDeliveries). */
const DELIVERY_SELECT_COLUMNS =
  "id,job_id,status,payload_json,created_at,response_index,payload_hash,host_unique_key,destination_type,destination_id,reply_message_id,cron_thread_id,external_message_id,lease_until,worker_id,fencing_token,attempts,next_attempt_at,last_error";

export class QueueRepository {
  readonly db: Database.Database;
  readonly workerId: string;
  constructor(
    dbOrPath?: Database.Database | string,
    workerId = "queue-single-host",
  ) {
    if (typeof dbOrPath === "string" || dbOrPath === undefined) {
      // openRuntimeDb opens AND configures the store: the schema migration runs
      // exactly once for path/:memory:/default construction.
      this.db = openRuntimeDb(dbOrPath);
    } else {
      this.db = dbOrPath;
      // An injected Database is not assumed to be configured; (re)run the
      // idempotent schema migration so callers can pass a raw better-sqlite3
      // connection, while already-initialized stores remain safe to reopen.
      configureRuntimeDb(this.db);
    }
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
  listTerminalCronJobs(): QueueJob[] {
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j
         WHERE json_extract(j.payload_json,'$.cronDeliveryMode')='item-thread'
           AND (
             j.status='dead_letter'
             OR (j.status='completed' AND EXISTS (
               SELECT 1 FROM deliveries d
               WHERE d.job_id=j.id AND d.status IN ('failed','ambiguous')
             ))
           )`,
      )
      .all() as JobRow[];
    return rows.map(parsePayload);
  }
  private createBotTaskSessionInTransaction(
    input: CreateBotTaskSessionInput,
  ): BotTaskSession {
    if (input.sourceKey) {
      const existing = this.db
        .prepare("SELECT * FROM bot_task_sessions WHERE source_key=?")
        .get(input.sourceKey) as BotTaskSessionRow | undefined;
      if (existing) return parseBotTaskSession(existing);
    }
    this.db
      .prepare(
        `INSERT INTO bot_task_sessions
          (session_id,handle,group_name,bot_id,channel_id,source_key,created_at,last_used_at,preview)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.sessionId,
        input.handle,
        input.groupName,
        input.botId,
        // Legacy channel_id is not part of Task Session metadata. Keep writing
        // an inert value so pre-existing NOT NULL schemas remain insertable.
        "",
        input.sourceKey ?? null,
        input.createdAt,
        input.createdAt,
        input.preview,
      );
    const created = this.db
      .prepare("SELECT * FROM bot_task_sessions WHERE session_id=?")
      .get(input.sessionId) as BotTaskSessionRow | undefined;
    if (!created)
      throw new Error(
        `failed to read back Bot task session ${input.sessionId}`,
      );
    return parseBotTaskSession(created);
  }
  createBotTaskSession(input: CreateBotTaskSessionInput): BotTaskSession {
    return this.inImmediateTransaction(() =>
      this.createBotTaskSessionInTransaction(input),
    );
  }
  private createBotTaskSessionAdmissionInTransaction(
    sessionId: string,
    groupName: string,
    createdAt: string,
  ): BotTaskSessionAdmission {
    const jobId = `bot-admission-${randomUUID()}`;
    const sequenceRow = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence),-1)+1 AS sequence FROM jobs WHERE session_id=?",
      )
      .get(sessionId) as { sequence: number };
    const payload: InboxMessage = {
      id: jobId,
      // Admission tickets are not delivered; this legacy payload field is
      // intentionally empty and is never used as a Task Session destination.
      channelId: "",
      groupName,
      sessionId,
      content: "",
      timestamp: createdAt,
      enqueuedAt: createdAt,
      retries: 0,
      botTaskSessionAdmission: true,
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id,idempotency_key,payload_json,session_id,sequence,status,attempts,max_attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        jobId,
        null,
        JSON.stringify(payload),
        sessionId,
        sequenceRow.sequence,
        "queued",
        0,
        1,
        createdAt,
        createdAt,
      );
    return { jobId, sessionId, sequence: sequenceRow.sequence };
  }
  createBotTaskSessionAndAdmission(input: CreateBotTaskSessionInput): {
    session: BotTaskSession;
    admission: BotTaskSessionAdmission;
  } {
    return this.inImmediateTransaction(() => {
      const session = this.createBotTaskSessionInTransaction(input);
      const admission = this.createBotTaskSessionAdmissionInTransaction(
        session.sessionId,
        session.groupName,
        input.createdAt,
      );
      return { session, admission };
    });
  }
  resumeBotTaskSessionAndAdmission(
    handle: string,
    groupName: string,
    botId: string,
    lastUsedAt: string,
  ):
    | { session: BotTaskSession; admission: BotTaskSessionAdmission }
    | undefined {
    return this.inImmediateTransaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM bot_task_sessions WHERE handle=? AND group_name=? AND bot_id=?",
        )
        .get(handle, groupName, botId) as BotTaskSessionRow | undefined;
      if (!row) return undefined;
      this.touchBotTaskSessionInTransaction(row.session_id, lastUsedAt);
      const session = parseBotTaskSession({
        ...row,
        last_used_at: lastUsedAt,
      });
      const admission = this.createBotTaskSessionAdmissionInTransaction(
        session.sessionId,
        groupName,
        lastUsedAt,
      );
      return { session, admission };
    });
  }
  admitBotTaskSessionAdmission(admission: BotTaskSessionAdmission): boolean {
    return this.inImmediateTransaction(() => {
      const blocked = this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE session_id=? AND sequence<? AND status NOT IN ('completed','dead_letter') LIMIT 1",
        )
        .get(admission.sessionId, admission.sequence);
      if (blocked) return false;
      const result = this.db
        .prepare(
          "UPDATE jobs SET status='running',updated_at=? WHERE id=? AND session_id=? AND sequence=? AND status='queued' AND json_extract(payload_json,'$.botTaskSessionAdmission')=1",
        )
        .run(
          nowIso(),
          admission.jobId,
          admission.sessionId,
          admission.sequence,
        );
      return result.changes === 1;
    });
  }
  /**
   * Admit a direct invocation only if it is immediately eligible. The admission
   * ticket is terminally cancelled in the same transaction when blocked, so it
   * cannot hold later work after the caller fails fast.
   */
  tryAdmitBotTaskSessionAdmission(
    admission: BotTaskSessionAdmission,
  ): "admitted" | "blocked" | "unavailable" {
    return this.inImmediateTransaction(() => {
      const blocked = this.db
        .prepare(
          "SELECT 1 FROM jobs WHERE session_id=? AND sequence<? AND status NOT IN ('completed','dead_letter') LIMIT 1",
        )
        .get(admission.sessionId, admission.sequence);
      if (blocked) {
        const at = nowIso();
        this.db
          .prepare(
            "UPDATE jobs SET status='dead_letter',completed_at=?,updated_at=?,terminal_reason='cancelled' WHERE id=? AND session_id=? AND sequence=? AND status='queued' AND json_extract(payload_json,'$.botTaskSessionAdmission')=1",
          )
          .run(
            at,
            at,
            admission.jobId,
            admission.sessionId,
            admission.sequence,
          );
        return "blocked";
      }
      const result = this.db
        .prepare(
          "UPDATE jobs SET status='running',updated_at=? WHERE id=? AND session_id=? AND sequence=? AND status='queued' AND json_extract(payload_json,'$.botTaskSessionAdmission')=1",
        )
        .run(
          nowIso(),
          admission.jobId,
          admission.sessionId,
          admission.sequence,
        );
      return result.changes === 1 ? "admitted" : "unavailable";
    });
  }
  completeBotTaskSessionAdmission(admission: BotTaskSessionAdmission): void {
    this.db
      .prepare(
        "UPDATE jobs SET status='completed',completed_at=?,updated_at=? WHERE id=? AND session_id=? AND sequence=? AND status='running' AND json_extract(payload_json,'$.botTaskSessionAdmission')=1",
      )
      .run(
        nowIso(),
        nowIso(),
        admission.jobId,
        admission.sessionId,
        admission.sequence,
      );
  }
  cancelBotTaskSessionAdmission(admission: BotTaskSessionAdmission): void {
    this.db
      .prepare(
        "UPDATE jobs SET status='dead_letter',completed_at=?,updated_at=?,terminal_reason='cancelled' WHERE id=? AND session_id=? AND sequence=? AND status IN ('queued','running') AND json_extract(payload_json,'$.botTaskSessionAdmission')=1",
      )
      .run(
        nowIso(),
        nowIso(),
        admission.jobId,
        admission.sessionId,
        admission.sequence,
      );
  }
  createBotTaskSessionAndEnqueue(
    input: CreateBotTaskSessionInput,
    payload: BotTaskSessionPayload,
    options: { idempotencyKey?: string; maxAttempts?: number } = {},
  ): BotTaskSessionEnqueueResult {
    return this.inImmediateTransaction(() => {
      const session = this.createBotTaskSessionInTransaction(input);
      const enqueue = this.enqueueInTransaction(
        { ...payload, sessionId: session.sessionId },
        options,
      );
      return { session, enqueue };
    });
  }
  findBotTaskSession(
    handle: string,
    groupName: string,
    botId: string,
  ): BotTaskSession | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM bot_task_sessions WHERE handle=? AND group_name=? AND bot_id=?",
      )
      .get(handle, groupName, botId) as BotTaskSessionRow | undefined;
    return row ? parseBotTaskSession(row) : undefined;
  }
  listBotTaskSessions(groupName: string, botId: string): BotTaskSession[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM bot_task_sessions WHERE group_name=? AND bot_id=? ORDER BY last_used_at DESC, created_at DESC",
      )
      .all(groupName, botId) as BotTaskSessionRow[];
    return rows.map(parseBotTaskSession);
  }
  private touchBotTaskSessionInTransaction(
    sessionId: string,
    lastUsedAt: string,
  ): void {
    this.db
      .prepare("UPDATE bot_task_sessions SET last_used_at=? WHERE session_id=?")
      .run(lastUsedAt, sessionId);
  }
  touchBotTaskSession(sessionId: string, lastUsedAt: string): void {
    this.inImmediateTransaction(() =>
      this.touchBotTaskSessionInTransaction(sessionId, lastUsedAt),
    );
  }
  recoverBotTaskSessionAdmissions(): void {
    this.inImmediateTransaction(() => {
      const now = nowIso();
      this.db
        .prepare(
          "UPDATE jobs SET status='dead_letter',completed_at=?,updated_at=?,terminal_reason='startup-recovery' WHERE json_extract(payload_json,'$.botTaskSessionAdmission')=1 AND status IN ('queued','running')",
        )
        .run(now, now);
    });
  }
  resumeBotTaskSessionAndEnqueue(
    handle: string,
    groupName: string,
    botId: string,
    lastUsedAt: string,
    payload: BotTaskSessionPayload,
    options: { idempotencyKey?: string; maxAttempts?: number } = {},
  ): BotTaskSessionEnqueueResult | undefined {
    return this.inImmediateTransaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM bot_task_sessions WHERE handle=? AND group_name=? AND bot_id=?",
        )
        .get(handle, groupName, botId) as BotTaskSessionRow | undefined;
      if (!row) return undefined;
      this.touchBotTaskSessionInTransaction(row.session_id, lastUsedAt);
      const enqueue = this.enqueueInTransaction(
        { ...payload, sessionId: row.session_id },
        options,
      );
      const updated = this.db
        .prepare("SELECT * FROM bot_task_sessions WHERE session_id=?")
        .get(row.session_id) as BotTaskSessionRow | undefined;
      if (!updated)
        throw new Error(
          `failed to read back Bot task session ${row.session_id}`,
        );
      return { session: parseBotTaskSession(updated), enqueue };
    });
  }
  /** Atomically provision a cron job and move it into the destination session ordering. */
  provisionCronJob(
    id: string,
    sessionId: string,
    patch: Partial<InboxMessage>,
  ): QueueJob | undefined {
    return this.inImmediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
        | JobRow
        | undefined;
      if (!row) return undefined;
      const payload = {
        ...(JSON.parse(row.payload_json) as InboxMessage),
        ...patch,
        sessionId,
        cronProvisioning: false,
        cronLegacyProvisioning: false,
      };
      this.db
        .prepare("UPDATE jobs SET sequence=sequence+1 WHERE session_id=?")
        .run(sessionId);
      this.db
        .prepare(
          "UPDATE jobs SET payload_json=?,session_id=?,sequence=0,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(payload), sessionId, nowIso(), id);
      return parsePayload(
        this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow,
      );
    });
  }
  /** Atomically merge provisioning state into an existing cron job payload. */
  patchJobPayload(
    id: string,
    patch: Partial<InboxMessage>,
  ): QueueJob | undefined {
    return this.inImmediateTransaction(() => {
      const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as
        | JobRow
        | undefined;
      if (!row) return undefined;
      const payload = {
        ...(JSON.parse(row.payload_json) as InboxMessage),
        ...patch,
      };
      this.db
        .prepare("UPDATE jobs SET payload_json=? WHERE id=?")
        .run(JSON.stringify(payload), id);
      const updated = this.db
        .prepare("SELECT * FROM jobs WHERE id=?")
        .get(id) as JobRow;
      return parsePayload(updated);
    });
  }
  private enqueueInTransaction(
    payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">,
    options: { idempotencyKey?: string; maxAttempts?: number } = {},
  ): EnqueueResult {
    const key = options.idempotencyKey ?? payload.idempotencyKey;
    if (key) {
      const idem = this.db
        .prepare("SELECT key,job_id,status FROM idempotency_keys WHERE key=?")
        .get(key) as
        | { key: string; job_id: string | null; status: string }
        | undefined;
      if (idem) {
        const existing = idem.job_id ? this.get(idem.job_id) : undefined;
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
    const job = this.get(id);
    if (job === undefined)
      throw new Error(`failed to read back enqueued job ${id}`);
    return { job, inserted: true };
  }
  enqueue(
    payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">,
    options: { idempotencyKey?: string; maxAttempts?: number } = {},
  ): EnqueueResult {
    return this.inImmediateTransaction(() =>
      this.enqueueInTransaction(payload, options),
    );
  }
  /**
   * Run one queue write as a BEGIN IMMEDIATE transaction with the historical
   * commit/rollback contract: each normal return value is committed, a thrown
   * error rolls back and rethrows, and the ROLLBACK sentinel rolls back and
   * yields undefined (claimDelivery's lost-race path). BEGIN IMMEDIATE takes
   * the write lock up front so two repository instances serialize exactly as
   * before, and nesting fails with the same "cannot start a transaction within
   * a transaction" error as the historical explicit exec-based blocks.
   */
  private inImmediateTransaction<T>(
    run: () => T | typeof TRANSACTION_ROLLBACK,
  ): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      if (result === TRANSACTION_ROLLBACK) {
        try {
          this.db.exec("ROLLBACK");
        } catch {}
        return undefined as never;
      }
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
    return this.inImmediateTransaction<ClaimedJob | undefined>(() => {
      const excluded = [...excludeIds];
      const excludedSql = excluded.length
        ? ` AND j.id NOT IN (${excluded.map(() => "?").join(",")})`
        : "";
      const eligible = `(json_extract(j.payload_json,'$.cronProvisioning') IS NOT 1 OR json_extract(j.payload_json,'$.cronLegacyProvisioning') IS NOT 1) AND ((j.status IN ('queued','retry_wait') AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=?)) OR (j.status IN ('claimed','running') AND j.lease_until<=?))`;
      const exhausted = this.db
        .prepare(
          `SELECT j.* FROM jobs j WHERE json_extract(j.payload_json,'$.botTaskSessionAdmission') IS NOT 1 AND ${eligible} AND j.attempts>=j.max_attempts${excludedSql}`,
        )
        .all(now, now, ...excluded) as JobRow[];
      for (const row of exhausted)
        this.deadLetterExhaustedInTransaction(row, "max_attempts");
      const row = this.db
        .prepare(
          `SELECT j.* FROM jobs j WHERE json_extract(j.payload_json,'$.botTaskSessionAdmission') IS NOT 1 AND ${eligible} AND j.attempts<j.max_attempts${excludedSql} AND NOT EXISTS (SELECT 1 FROM jobs blocker WHERE json_extract(blocker.payload_json,'$.cronProvisioning')=1 AND json_extract(blocker.payload_json,'$.cronThreadId')=j.session_id) AND NOT EXISTS (SELECT 1 FROM jobs prior WHERE prior.session_id=j.session_id AND prior.sequence<j.sequence AND prior.status NOT IN ('completed','dead_letter')) ORDER BY j.created_at,j.sequence LIMIT 1`,
        )
        .get(now, now, ...excluded) as JobRow | undefined;
      if (!row) return undefined;
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
      const claimed = this.get(row.id);
      return claimed ? { job: claimed, fencingToken: token } : undefined;
    });
  }
  releaseClaim(id: string, token: number): void {
    this.fenced(id, token, {
      status: "queued",
      claimed: 0,
      lease_until: null,
      worker_id: null,
      next_attempt_at: null,
    });
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
    const row = this.db
      .prepare("SELECT payload_json FROM jobs WHERE id=?")
      .get(id) as { payload_json: string } | undefined;
    if (!row) throw new Error(`unknown job ${id}`);
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    // payload_json holds the durable InboxMessage domain payload only. Execution
    // metadata (claim/lease timestamps, exit info, timings, snapshot hashes,
    // workspace paths, ...) lives in dedicated SQL columns; never fold the
    // get()-merged QueueJob view or SQL columns back into payload_json. Strip
    // pure metadata keys so previously leaked rows are also cleaned up, while
    // legitimate InboxMessage fields (snapshotHash, toolCallKey, completedAt, ...)
    // pass through untouched.
    for (const key of [
      "executionState",
      "claimedAt",
      "startedAt",
      "heartbeatAt",
      "exitCode",
      "termination",
      "stopReason",
      "usage",
      "timing",
      "error",
      "systemPromptSnapshotHash",
      "memorySnapshotHash",
      "workspacePath",
      "conversationPath",
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
      "executionState",
      "claimedAt",
      "startedAt",
      "heartbeatAt",
      "exitCode",
      "termination",
      "stopReason",
      "usage",
      "timing",
      "error",
      "systemPromptSnapshotHash",
      "memorySnapshotHash",
      "workspacePath",
      "conversationPath",
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
    // status/`claimed` mirror plus attempt timestamps are markRunning-specific;
    // the remaining execution metadata columns come from the shared mapping.
    this.fenced(id, token, {
      status: "running",
      claimed: 0,
      started_at: metadata.startedAt ?? nowIso(),
      heartbeat_at: nowIso(),
      ...metadataSetColumns(metadata),
    });
  }
  freezeExecutionIdentity(
    id: string,
    token: number,
    identity: {
      snapshotHash?: string;
      toolCallKey?: string;
      systemPromptSnapshotContent?: string;
      memorySnapshotContent?: string;
      systemPromptSnapshotPresent?: boolean;
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
      ...(identity.systemPromptSnapshotContent !== undefined
        ? { systemPromptSnapshotContent: identity.systemPromptSnapshotContent }
        : {}),
      ...(identity.memorySnapshotContent !== undefined
        ? { memorySnapshotContent: identity.memorySnapshotContent }
        : {}),
      ...(identity.systemPromptSnapshotPresent !== undefined
        ? { systemPromptSnapshotPresent: identity.systemPromptSnapshotPresent }
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
      suppressDelivery?: boolean;
      metadata?: ExecutionMetadata;
      deliveryPayload?: unknown;
      shadowJob?: ShadowJobAdmission;
    } = {},
  ): DeliveryRow | undefined {
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
    const chunks =
      options.empty || options.suppressDelivery
        ? []
        : splitMessage(
            typeof result === "string"
              ? result
              : JSON.stringify(result ?? null),
          );
    return this.inImmediateTransaction<DeliveryRow | undefined>(() => {
      const row = this.db
        .prepare(
          "SELECT idempotency_key FROM jobs WHERE id=? AND status IN ('claimed','running') AND fencing_token=?",
        )
        .get(id, token) as { idempotency_key: string | null } | undefined;
      if (!row) throw new Error(`stale fencing token for job ${id}`);
      const changed = this.db
        .prepare(
          `UPDATE jobs SET status='completed',lease_until=NULL,worker_id=NULL,completed_at=?,result_json=?,result_state=?,succeeded=?,delivery_id=NULL,${metadataCoalesceAssignments()} WHERE id=? AND status IN ('claimed','running') AND fencing_token=?`,
        )
        .run(
          at,
          resultJson,
          state,
          options.empty ? 0 : 1,
          ...metadataCoalesceValues(m),
          id,
          token,
        );
      if (changed.changes !== 1)
        throw new Error(`stale fencing token for job ${id}`);
      let first: DeliveryRow | undefined;
      for (const [index, content] of chunks.entries()) {
        const replyMessageId =
          index === 0 ? deliveryMeta.replyMessageId : undefined;
        const payloadMetadata = { ...deliveryMeta };
        if (index > 0) {
          delete payloadMetadata.replyMessageId;
          delete payloadMetadata.cronPlaceholderMessageId;
        }
        const payload = hasDeliveryMeta
          ? JSON.stringify({
              ...payloadMetadata,
              content,
              responseIndex: index,
            })
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
            replyMessageId ?? null,
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
      // Shadow admission shares this transaction with the source result and
      // delivery rows. Remote MemoryCore I/O happens later when this job is
      // independently claimed.
      if (options.shadowJob)
        this.enqueueInTransaction(
          options.shadowJob.payload,
          options.shadowJob.options,
        );
      // An empty response enqueues no delivery chunks, so no DeliveryRow is
      // created. Return undefined instead of a fabricated "sent" row; every
      // caller either ignores the return value or only forwards real rows.
      return first;
    });
  }
  heartbeat(id: string, token: number, leaseMs = 60_000): void {
    this.fenced(id, token, {
      lease_until: new Date(Date.now() + Math.max(1, leaseMs)).toISOString(),
      heartbeat_at: nowIso(),
    });
  }
  complete(id: string, token: number): void {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    if (job.executionState === "claimed") this.markRunning(id, token);
    if (job.resultJson === undefined)
      this.commitResult(id, token, "", { empty: true });
  }
  /** Record a failed execution attempt, applying durable retry policy. */
  failAttempt(
    id: string,
    error: unknown,
    fencingToken: number | undefined,
    options: FailAttemptOptions = {},
  ): void {
    const job = this.get(id);
    if (!job) throw new Error(`unknown job ${id}`);
    if (job.status !== "running" && job.status !== "claimed")
      throw new Error(`job ${id} is not active`);
    const token = fencingToken ?? job.fencingToken;
    if (token !== job.fencingToken)
      throw new Error(`stale fencing token for ${id}`);
    const delayMs = Math.min(1000 * 2 ** job.retries, 60_000);
    this.retry(
      id,
      token,
      error,
      delayMs,
      options.payloadPatch,
      options.metadata,
    );
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
        ...metadataSetColumns(metadata),
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
      result_state:
        reason === "max_attempts"
          ? "max_retries"
          : reason === "empty_response"
            ? "empty_response"
            : "non_retryable",
      error_json: JSON.stringify({ message: error ?? reason, error }),
      ...metadataSetColumns(metadata),
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
  getDiscordCursor(scopeId: string): string | undefined {
    const row = this.db
      .prepare(
        "SELECT last_message_id FROM discord_sync_cursors WHERE scope_id=?",
      )
      .get(scopeId) as { last_message_id?: string } | undefined;
    return row?.last_message_id || undefined;
  }
  isDiscordCursorInitialized(scopeId: string): boolean {
    const row = this.db
      .prepare("SELECT initialized FROM discord_sync_cursors WHERE scope_id=?")
      .get(scopeId) as { initialized?: number } | undefined;
    return row?.initialized === 1;
  }
  initializeDiscordCursor(scopeId: string): void {
    this.db
      .prepare(
        "INSERT INTO discord_sync_cursors(scope_id,last_message_id,updated_at,initialized) VALUES(?,?,?,1) ON CONFLICT(scope_id) DO UPDATE SET initialized=1,updated_at=excluded.updated_at",
      )
      .run(scopeId, "", nowIso());
  }
  upsertDiscordCursor(scopeId: string, messageId: string): void {
    const current = this.getDiscordCursor(scopeId);
    if (current !== undefined && compareSnowflakeIds(messageId, current) <= 0)
      return;
    this.db
      .prepare(
        "INSERT INTO discord_sync_cursors(scope_id,last_message_id,updated_at,initialized) VALUES(?,?,?,1) ON CONFLICT(scope_id) DO UPDATE SET last_message_id=excluded.last_message_id,updated_at=excluded.updated_at,initialized=1",
      )
      .run(scopeId, messageId, nowIso());
  }
  getDelivery(jobId: string): DeliveryRow | undefined {
    const row = this.db
      .prepare(
        `SELECT ${DELIVERY_SELECT_COLUMNS} FROM deliveries WHERE job_id=? ORDER BY response_index LIMIT 1`,
      )
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? this.parseDelivery(row) : undefined;
  }
  listDeliveries(status?: DeliveryStatus): DeliveryRow[] {
    const rows = (
      status
        ? this.db
            .prepare(
              `SELECT ${DELIVERY_SELECT_COLUMNS} FROM deliveries WHERE status=? ORDER BY job_id,response_index`,
            )
            .all(status)
        : this.db
            .prepare(
              `SELECT ${DELIVERY_SELECT_COLUMNS} FROM deliveries ORDER BY job_id,response_index`,
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
    return this.inImmediateTransaction<DeliveryClaim | undefined>(() => {
      this.db
        .prepare(
          "UPDATE deliveries SET status='ambiguous',lease_until=NULL,worker_id=NULL,last_error=COALESCE(last_error,'sending lease expired'),updated_at=? WHERE status='sending' AND lease_until<=?",
        )
        .run(now, now);
      // A late item-thread promotion records the parent/thread ID on the job
      // before delivery persistence. Recover that durable marker before a
      // retry so a crash in the persistence window cannot send a second parent.
      this.db
        .prepare(
          `UPDATE deliveries
           SET cron_thread_id=(SELECT json_extract(j.payload_json,'$.cronThreadId') FROM jobs j WHERE j.id=deliveries.job_id),updated_at=?
           WHERE deliveries.cron_thread_id IS NULL
             AND deliveries.status IN ('pending','retry_wait')
             AND EXISTS (
               SELECT 1 FROM jobs j
               WHERE j.id=deliveries.job_id
                 AND json_extract(j.payload_json,'$.cronDeliveryMode')='item-thread'
                 AND json_extract(j.payload_json,'$.cronThreadId') IS NOT NULL
             )`,
        )
        .run(now);
      // `created_at` is millisecond precision and `response_index` is scoped
      // to a job, so neither column alone fully orders candidates. `deliveries`
      // uses SQLite's implicit rowid as its insertion order; SQLite serialize
      // backups preserve those rowids, but arbitrary table rebuilds or VACUUM
      // do not necessarily do so. Legacy table copies above therefore preserve
      // their source rowid order explicitly.
      const row = this.db
        .prepare(
          `SELECT candidate.* FROM deliveries AS candidate
           WHERE candidate.status IN ('pending','retry_wait')
             AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at<=?)
             AND NOT EXISTS (
               SELECT 1 FROM deliveries AS predecessor
               WHERE predecessor.job_id=candidate.job_id
                 AND predecessor.response_index<candidate.response_index
                 AND predecessor.status NOT IN ('sent')
                 AND NOT (EXISTS (SELECT 1 FROM jobs rss_job WHERE rss_job.id=candidate.job_id AND json_extract(rss_job.payload_json,'$.rssDispatchId') IS NOT NULL) AND predecessor.status='failed')
             )
           ORDER BY candidate.created_at,candidate.response_index,candidate.rowid LIMIT 1`,
        )
        .get(now) as Record<string, unknown> | undefined;
      if (!row) return undefined;
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
      if (changed.changes !== 1) return TRANSACTION_ROLLBACK;
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
      return { row: this.parseDelivery(claimed), fencingToken: token };
    });
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
  failRssDelivery(
    id: string,
    token: number,
    status: "failed" | "ambiguous",
    error: string,
  ): void {
    this.inImmediateTransaction(() => {
      const row = this.db
        .prepare(
          "SELECT job_id FROM deliveries WHERE id=? AND status='sending' AND fencing_token=?",
        )
        .get(id, token) as { job_id: string } | undefined;
      if (!row) throw new Error(`stale fencing token for delivery ${id}`);
      const at = nowIso();
      const changed = this.db
        .prepare(
          "UPDATE deliveries SET status=?,last_error=?,lease_until=NULL,worker_id=NULL,updated_at=? WHERE id=? AND status='sending' AND fencing_token=?",
        )
        .run(status, error, at, id, token);
      if (changed.changes !== 1)
        throw new Error(`stale fencing token for delivery ${id}`);
      this.db
        .prepare(
          "UPDATE deliveries SET status='failed',last_error=?,lease_until=NULL,worker_id=NULL,updated_at=? WHERE job_id=? AND id<>? AND status IN ('pending','retry_wait')",
        )
        .run(error, at, row.job_id, id);
    });
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
  setDeliveryThread(id: string, token: number, cronThreadId: string): void {
    this.inImmediateTransaction(() => {
      const row = this.db
        .prepare(
          "SELECT job_id FROM deliveries WHERE id=? AND status='sending' AND fencing_token=?",
        )
        .get(id, token) as { job_id: string } | undefined;
      if (!row) throw new Error(`stale fencing token for delivery ${id}`);
      const at = nowIso();
      this.db
        .prepare(
          "UPDATE deliveries SET cron_thread_id=?,updated_at=? WHERE id=? AND status='sending' AND fencing_token=?",
        )
        .run(cronThreadId, at, id, token);
      // A response is split into ordered delivery rows. Once the first row
      // creates its thread, every still-unsent row for that job must target
      // the same thread rather than creating another one.
      this.db
        .prepare(
          "UPDATE deliveries SET cron_thread_id=?,updated_at=? WHERE job_id=? AND id<>? AND status IN ('pending','retry_wait') AND cron_thread_id IS NULL",
        )
        .run(cronThreadId, at, row.job_id, id);
    });
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
  if (defaultRepository === undefined) {
    defaultRepository = new QueueRepository();
  }
  return defaultRepository;
}
export function closeQueueRepository(): void {
  defaultRepository?.close();
  defaultRepository = undefined;
}
