import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";
import {
  type SessionExecution,
  SessionExecutionSchema,
  type SessionSource,
  SessionSourceSchema,
} from "./source.js";

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), "data", "sessions");
const DB_FILENAME = "sessions.sqlite";
const SCHEMA_VERSION = 3;

function validateName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`不正な${label}: ${name}`);
  }
}

function groupDir(groupName: string): string {
  return path.join(SESSIONS_DIR, groupName);
}

async function ensureDir(groupName: string): Promise<string> {
  const dir = groupDir(groupName);
  await mkdir(dir, { recursive: true, mode: 0o777 });
  // VirtioFS では mkdir の mode は既存ディレクトリに適用されないため明示的に設定
  await chmod(dir, 0o777).catch(() => {});
  return dir;
}

function hasArrayContent(
  msg: object,
): msg is { content: Array<{ type?: string }> } {
  return (
    "content" in msg && Array.isArray((msg as { content: unknown }).content)
  );
}

function sanitizeMessage(message: AgentMessage): Record<string, unknown> {
  // 推論モデルが実行時に付与する非履歴フィールドをcanonical trajectoryへ保存しない。
  const {
    reasoning: _reasoning,
    reasoning_content: _legacy,
    ...rest
  } = message as AgentMessage & {
    reasoning?: unknown;
    reasoning_content?: unknown;
  };
  const sanitized: Record<string, unknown> = { ...rest };
  if (hasArrayContent(rest)) {
    sanitized.content = rest.content.filter(
      (block) => block.type !== "thinking",
    );
  }
  return sanitized;
}

function parseStoredMessage(payload: string): AgentMessage {
  const message = JSON.parse(payload) as Record<string, unknown>;
  delete message.reasoning;
  delete message.reasoning_content;
  if (Array.isArray(message.content)) {
    message.content = (message.content as Array<{ type?: string }>).filter(
      (block) => block.type !== "thinking",
    );
  }
  return message as unknown as AgentMessage;
}

function entryType(message: Record<string, unknown>): string {
  if (typeof message.customType === "string") return message.customType;
  return typeof message.role === "string" ? message.role : "unknown";
}

function messageTimestamp(message: Record<string, unknown>): number {
  return typeof message.timestamp === "number" &&
    Number.isFinite(message.timestamp)
    ? message.timestamp
    : Date.now();
}

function initializeSchema(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Already-current stores need no migration write lock.
  if (db.pragma("user_version", { simple: true }) === SCHEMA_VERSION) return;
  db.transaction(() => {
    // Another run/container may have migrated while we waited for the lock.
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `未対応のsession DB schema versionです: ${version} (対応: ${SCHEMA_VERSION})`,
      );
    }
    if (version === 0) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'conversation',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON UPDATE CASCADE ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          entry_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(session_id, sequence)
        );
        CREATE INDEX IF NOT EXISTS session_entries_session_id_id
          ON session_entries(session_id, id);
        PRAGMA user_version = 1;
      `);
    }
    if (version < 2) {
      db.exec(`
        ALTER TABLE session_entries ADD COLUMN source_json TEXT;
        CREATE INDEX session_entries_source ON session_entries(id) WHERE source_json IS NOT NULL;
        PRAGMA user_version = 2;
      `);
    }
    if (version < 3) {
      db.exec(`
        ALTER TABLE session_entries ADD COLUMN execution_json TEXT;
        CREATE INDEX session_entries_execution ON session_entries(
          session_id, json_extract(execution_json, '$.jobId'),
          json_extract(execution_json, '$.fencingToken'), sequence
        ) WHERE execution_json IS NOT NULL;
        PRAGMA user_version = 3;
      `);
    }
  }).immediate();
}

async function openDatabase(groupName: string): Promise<Database.Database> {
  const dir = await ensureDir(groupName);
  const dbPath = path.join(dir, DB_FILENAME);
  const db = new Database(dbPath);
  try {
    initializeSchema(db);
    await chmod(dbPath, 0o666).catch(() => {});
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function sessionConversationPath(
  groupName: string,
  sessionId: string,
): string {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  return `data/sessions/${groupName}/${DB_FILENAME}#session=${sessionId}`;
}

export async function loadMessages(
  groupName: string,
  sessionId: string,
): Promise<AgentMessage[]> {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  const db = await openDatabase(groupName);
  try {
    const rows = db
      .prepare(
        "SELECT payload_json FROM session_entries WHERE session_id=? ORDER BY sequence",
      )
      .all(sessionId) as Array<{ payload_json: string }>;
    return rows.map((row) => parseStoredMessage(row.payload_json));
  } finally {
    db.close();
  }
}

/** A sourced user and following entries from the same identified runtime attempt. */
export interface SourceTrajectory {
  sessionId: string;
  source: SessionSource;
  execution: SessionExecution;
  user: AgentMessage;
  following: AgentMessage[];
}

/** Read-only, paged scan. No read transaction is held while the caller awaits I/O. */
export function* readSourceTrajectories(
  groupName: string,
  includeExecution: (execution: SessionExecution) => boolean,
): Generator<SourceTrajectory> {
  validateName(groupName, "グループ名");
  const dbPath = path.join(groupDir(groupName), DB_FILENAME);
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    // Older schemas cannot establish committed attempts; never infer them from text.
    if (version === 1 || version === 2) return;
    if (version !== SCHEMA_VERSION)
      throw new Error(`Unsupported session schema: ${version}`);
    const sources = db.prepare(`
      SELECT id, session_id, sequence, source_json, execution_json, payload_json
      FROM session_entries
      WHERE source_json IS NOT NULL AND execution_json IS NOT NULL AND id > ?
      ORDER BY id LIMIT 100
    `);
    const following = db.prepare(`
      SELECT payload_json FROM session_entries
      WHERE session_id = ? AND sequence > ? AND execution_json IS NOT NULL
        AND json_extract(execution_json, '$.jobId') = ?
        AND json_extract(execution_json, '$.fencingToken') = ?
      ORDER BY sequence
    `);
    let cursor = 0;
    for (;;) {
      const rows = sources.all(cursor) as Array<{
        id: number;
        session_id: string;
        sequence: number;
        source_json: string;
        execution_json: string;
        payload_json: string;
      }>;
      if (rows.length === 0) return;
      for (const row of rows) {
        cursor = row.id;
        const user = parseStoredMessage(row.payload_json);
        if (user.role !== "user") continue;
        const execution = SessionExecutionSchema.parse(
          JSON.parse(row.execution_json),
        );
        // Check authority before reading the response, not after taking a possibly unfinished snapshot.
        if (!includeExecution(execution)) continue;
        const entries = following.all(
          row.session_id,
          row.sequence,
          execution.jobId,
          execution.fencingToken,
        ) as Array<{ payload_json: string }>;
        yield {
          sessionId: row.session_id,
          source: SessionSourceSchema.parse(JSON.parse(row.source_json)),
          execution,
          user,
          following: entries.map((entry) =>
            parseStoredMessage(entry.payload_json),
          ),
        };
      }
    }
  } finally {
    db.close();
  }
}

export async function renameSession(
  groupName: string,
  fromSessionId: string,
  toSessionId: string,
): Promise<void> {
  validateName(groupName, "グループ名");
  validateName(fromSessionId, "セッションID");
  validateName(toSessionId, "セッションID");
  if (fromSessionId === toSessionId) return;

  const db = await openDatabase(groupName);
  try {
    db.transaction(() => {
      const source = db
        .prepare("SELECT 1 FROM sessions WHERE id=?")
        .get(fromSessionId);
      if (!source)
        throw new Error(`セッションが見つかりません: ${fromSessionId}`);
      const destination = db
        .prepare("SELECT 1 FROM sessions WHERE id=?")
        .get(toSessionId);
      if (destination) {
        throw new Error(
          `リネーム先のセッションが既に存在します: ${toSessionId}`,
        );
      }
      db.prepare("UPDATE sessions SET id=?, updated_at=? WHERE id=?").run(
        toSessionId,
        Date.now(),
        fromSessionId,
      );
    })();
  } finally {
    db.close();
  }
}

export async function appendMessage(
  groupName: string,
  sessionId: string,
  message: AgentMessage,
  source?: SessionSource,
  execution?: SessionExecution,
): Promise<void> {
  if (source && message.role !== "user") {
    throw new Error("source provenance requires a user entry");
  }
  const sourceJson = source
    ? JSON.stringify(SessionSourceSchema.parse(source))
    : null;
  const executionJson = execution
    ? JSON.stringify(SessionExecutionSchema.parse(execution))
    : null;
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  const db = await openDatabase(groupName);
  const sanitized = sanitizeMessage(message);
  const timestamp = messageTimestamp(sanitized);

  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO sessions(id, created_at, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at
      `).run(sessionId, timestamp, timestamp);
      db.prepare(`
        INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at, source_json, execution_json)
        SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?, ?
        FROM session_entries WHERE session_id=?
      `).run(
        sessionId,
        entryType(sanitized),
        JSON.stringify(sanitized),
        timestamp,
        sourceJson,
        executionJson,
        sessionId,
      );
    })();
  } finally {
    db.close();
  }
}
