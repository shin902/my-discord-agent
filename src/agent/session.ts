import { existsSync } from "node:fs";
import { chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import type { ConversationEntries } from "./conversation.js";
import { type SessionSource, SessionSourceSchema } from "./source.js";

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), "data", "sessions");
const DB_FILENAME = "sessions.sqlite";
const SCHEMA_VERSION = 6;

function validateName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`不正な${label}: ${name}`);
  }
}

function validateOwner(agentId: string): void {
  // Bot registry IDs are arbitrary non-empty strings, not path components.
  if (typeof agentId !== "string" || agentId.length === 0)
    throw new Error("Agent IDが不正です");
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
    if (version === SCHEMA_VERSION) return;
    if (version !== 0) {
      throw new Error(
        `未対応のsession DB schema versionです: ${version} (対応: ${SCHEMA_VERSION})`,
      );
    }
    db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'conversation',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          PRIMARY KEY (agent_id, id)
        );
        CREATE TABLE IF NOT EXISTS session_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          entry_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          source_json TEXT,
          FOREIGN KEY (agent_id, session_id) REFERENCES sessions(agent_id, id)
            ON UPDATE CASCADE ON DELETE CASCADE,
          UNIQUE(agent_id, session_id, sequence)
        );
      `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
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
  agentId: string,
): string {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  validateOwner(agentId);
  const owner =
    agentId === "main" ? "" : `&agent=${encodeURIComponent(agentId)}`;
  return `data/sessions/${groupName}/${DB_FILENAME}#session=${sessionId}${owner}`;
}

export async function loadMessages(
  groupName: string,
  sessionId: string,
  agentId: string,
): Promise<AgentMessage[]> {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  validateOwner(agentId);
  const db = await openDatabase(groupName);
  try {
    const rows = db
      .prepare(
        "SELECT payload_json FROM session_entries WHERE agent_id=? AND session_id=? ORDER BY sequence",
      )
      .all(agentId, sessionId) as Array<{ payload_json: string }>;
    return rows.map((row) => parseStoredMessage(row.payload_json));
  } finally {
    db.close();
  }
}

/** Exact entries adopted by the host; no attempt or final-response inference. */
export interface SourceConversation {
  sessionId: string;
  source: SessionSource;
  user: AgentMessage;
  assistant: AgentMessage;
}

/** Read-only lookup. No read transaction is held while the caller awaits I/O. */
export function* readConversations(
  groupName: string,
  entries: Iterable<ConversationEntries>,
): Generator<SourceConversation> {
  validateName(groupName, "グループ名");
  const dbPath = path.join(groupDir(groupName), DB_FILENAME);
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    // Pre-reference stores have no adopted conversations; do not migrate on export.
    if (version >= 1 && version < 5) return;
    if (version !== SCHEMA_VERSION)
      throw new Error(`Unsupported session schema: ${version}`);
    const lookup = db.prepare(`
      SELECT u.session_id, u.source_json, u.payload_json AS user_json,
        a.payload_json AS assistant_json
      FROM session_entries u JOIN session_entries a
        ON a.agent_id = u.agent_id AND a.session_id = u.session_id
      WHERE u.id = ? AND a.id = ? AND u.entry_type = 'user'
        AND a.entry_type = 'assistant' AND u.source_json IS NOT NULL
    `);
    for (const entry of entries) {
      const row = lookup.get(entry.userEntryId, entry.assistantEntryId) as
        | {
            session_id: string;
            source_json: string;
            user_json: string;
            assistant_json: string;
          }
        | undefined;
      // Source deletion makes the reference unresolvable; never substitute nearby entries.
      if (!row) continue;
      yield {
        sessionId: row.session_id,
        source: SessionSourceSchema.parse(JSON.parse(row.source_json)),
        user: parseStoredMessage(row.user_json),
        assistant: parseStoredMessage(row.assistant_json),
      };
    }
  } finally {
    db.close();
  }
}

/** Project exact adopted finals for one owner/session, without requiring user provenance. */
export function readSessionFinalResponses(
  groupName: string,
  sessionId: string,
  agentId: string,
  entries: Iterable<ConversationEntries>,
): AssistantMessage[] {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  validateOwner(agentId);
  const dbPath = path.join(groupDir(groupName), DB_FILENAME);
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version !== SCHEMA_VERSION)
      throw new Error(`Unsupported session schema: ${version}`);
    const lookup = db.prepare(`
      SELECT a.payload_json FROM session_entries u JOIN session_entries a
        ON a.agent_id=u.agent_id AND a.session_id=u.session_id
      WHERE u.id=? AND a.id=? AND a.agent_id=? AND a.session_id=?
        AND u.entry_type='user' AND a.entry_type='assistant'
    `);
    const finals: AssistantMessage[] = [];
    const seen = new Set<number>();
    for (const entry of entries) {
      if (seen.has(entry.assistantEntryId)) continue;
      seen.add(entry.assistantEntryId);
      const row = lookup.get(
        entry.userEntryId,
        entry.assistantEntryId,
        agentId,
        sessionId,
      ) as { payload_json: string } | undefined;
      if (!row) continue;
      const message = parseStoredMessage(row.payload_json);
      if (
        message.role !== "assistant" ||
        message.errorMessage ||
        (message.stopReason !== "stop" && message.stopReason !== "length") ||
        message.content.some((block) => block.type === "toolCall")
      )
        continue;
      const content = message.content.filter((block) => block.type === "text");
      if (
        !content
          .map((block) => block.text)
          .join("")
          .trim()
      )
        continue;
      finals.push({ ...message, content });
    }
    return finals;
  } finally {
    db.close();
  }
}

/** Read-only trajectories with user input, ordered by creation time/ID then entry sequence. */
export function* readOwnerSessions(
  groupName: string,
  agentId: string,
): Generator<{ sessionId: string; message: AgentMessage }> {
  validateName(groupName, "グループ名");
  validateOwner(agentId);
  const dbPath = path.join(groupDir(groupName), DB_FILENAME);
  if (!existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version !== SCHEMA_VERSION)
      throw new Error(`Unsupported session schema: ${version}`);
    const sessions = db.prepare(
      `SELECT id FROM sessions s WHERE agent_id=?
        AND EXISTS (SELECT 1 FROM session_entries e
          WHERE e.agent_id=s.agent_id AND e.session_id=s.id AND e.entry_type='user')
        ORDER BY created_at, id`,
    );
    const entries = db.prepare(
      "SELECT payload_json FROM session_entries WHERE agent_id=? AND session_id=? ORDER BY sequence",
    );
    for (const { id } of sessions.iterate(agentId) as Iterable<{
      id: string;
    }>) {
      for (const { payload_json } of entries.iterate(agentId, id) as Iterable<{
        payload_json: string;
      }>) {
        yield { sessionId: id, message: parseStoredMessage(payload_json) };
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
  agentId: string,
): Promise<void> {
  validateName(groupName, "グループ名");
  validateName(fromSessionId, "セッションID");
  validateName(toSessionId, "セッションID");
  validateOwner(agentId);
  if (fromSessionId === toSessionId) return;

  const db = await openDatabase(groupName);
  try {
    db.transaction(() => {
      const source = db
        .prepare("SELECT 1 FROM sessions WHERE agent_id=? AND id=?")
        .get(agentId, fromSessionId);
      if (!source)
        throw new Error(`セッションが見つかりません: ${fromSessionId}`);
      const destination = db
        .prepare("SELECT 1 FROM sessions WHERE agent_id=? AND id=?")
        .get(agentId, toSessionId);
      if (destination) {
        throw new Error(
          `リネーム先のセッションが既に存在します: ${toSessionId}`,
        );
      }
      db.prepare(
        "UPDATE sessions SET id=?, updated_at=? WHERE agent_id=? AND id=?",
      ).run(toSessionId, Date.now(), agentId, fromSessionId);
    })();
  } finally {
    db.close();
  }
}

export async function appendMessage(
  groupName: string,
  sessionId: string,
  message: AgentMessage,
  agentId: string,
  source?: SessionSource,
): Promise<number> {
  if (source && message.role !== "user") {
    throw new Error("source provenance requires a user entry");
  }
  const sourceJson = source
    ? JSON.stringify(SessionSourceSchema.parse(source))
    : null;
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  validateOwner(agentId);
  const db = await openDatabase(groupName);
  const sanitized = sanitizeMessage(message);
  const timestamp = messageTimestamp(sanitized);

  try {
    const append = db.transaction(() => {
      if (source) {
        const existing = db
          .prepare(`
            SELECT id FROM session_entries WHERE agent_id=? AND session_id=?
              AND json_extract(source_json, '$.kind')=?
              AND json_extract(source_json, '$.sourceId')=?
          `)
          .get(agentId, sessionId, source.kind, source.sourceId) as
          | { id: number }
          | undefined;
        if (existing) return existing.id;
      }
      db.prepare(`
        INSERT INTO sessions(id, created_at, updated_at, agent_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(agent_id, id) DO UPDATE SET updated_at=excluded.updated_at
      `).run(sessionId, timestamp, timestamp, agentId);
      const inserted = db
        .prepare(`
        INSERT INTO session_entries(agent_id, session_id, sequence, entry_type, payload_json, created_at, source_json)
        SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?, ?
        FROM session_entries WHERE agent_id=? AND session_id=?
      `)
        .run(
          agentId,
          sessionId,
          entryType(sanitized),
          JSON.stringify(sanitized),
          timestamp,
          sourceJson,
          agentId,
          sessionId,
        );
      return Number(inserted.lastInsertRowid);
    });
    return append.immediate();
  } finally {
    db.close();
  }
}
