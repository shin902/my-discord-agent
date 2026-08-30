import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import Database from "better-sqlite3";

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), "data", "sessions");
const DB_FILENAME = "sessions.sqlite";
const SCHEMA_VERSION = 1;

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
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `未対応のsession DB schema versionです: ${version} (対応: ${SCHEMA_VERSION})`,
    );
  }
  if (version === 0) {
    db.exec(`
      PRAGMA foreign_keys = ON;
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
      CREATE TABLE IF NOT EXISTS session_store_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

async function importLegacyJsonl(
  db: Database.Database,
  dir: string,
): Promise<void> {
  const imported = db
    .prepare(
      "SELECT value FROM session_store_metadata WHERE key='legacy_jsonl_imported'",
    )
    .get() as { value: string } | undefined;
  if (imported?.value === "1") return;

  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((a, b) => a.name.localeCompare(b.name));
  const inputs = await Promise.all(
    files.map(async (file) => ({
      sessionId: file.name.slice(0, -".jsonl".length),
      file: path.join(dir, file.name),
      text: await readFile(path.join(dir, file.name), "utf-8"),
    })),
  );

  const insertSession = db.prepare(
    "INSERT INTO sessions(id, created_at, updated_at) VALUES (?, ?, ?)",
  );
  const insertEntry = db.prepare(`
    INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const markImported = db.prepare(
    "INSERT INTO session_store_metadata(key, value) VALUES ('legacy_jsonl_imported', '1')",
  );

  db.transaction(() => {
    const alreadyImported = db
      .prepare(
        "SELECT value FROM session_store_metadata WHERE key='legacy_jsonl_imported'",
      )
      .get() as { value: string } | undefined;
    if (alreadyImported?.value === "1") return;

    for (const input of inputs) {
      validateName(input.sessionId, "セッションID");
      const lines = input.text.split("\n").filter((line) => line.trim());
      const messages = lines.map((line, index) => {
        try {
          return sanitizeMessage(parseStoredMessage(line));
        } catch (error) {
          throw new Error(
            `legacy session JSONLの読み込みに失敗しました: ${input.file}:${index + 1}`,
            { cause: error },
          );
        }
      });
      const timestamps = messages.map(messageTimestamp);
      const createdAt = timestamps[0] ?? Date.now();
      const updatedAt = timestamps.at(-1) ?? createdAt;
      insertSession.run(input.sessionId, createdAt, updatedAt);
      messages.forEach((message, index) => {
        insertEntry.run(
          input.sessionId,
          index + 1,
          entryType(message),
          JSON.stringify(message),
          timestamps[index],
        );
      });
    }
    markImported.run();
  })();
}

async function openDatabase(groupName: string): Promise<Database.Database> {
  const dir = await ensureDir(groupName);
  const dbPath = path.join(dir, DB_FILENAME);
  const db = new Database(dbPath);
  try {
    initializeSchema(db);
    await importLegacyJsonl(db, dir);
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
): Promise<void> {
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
        INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at)
        SELECT ?, COALESCE(MAX(sequence), 0) + 1, ?, ?, ?
        FROM session_entries WHERE session_id=?
      `).run(
        sessionId,
        entryType(sanitized),
        JSON.stringify(sanitized),
        timestamp,
        sessionId,
      );
    })();
  } finally {
    db.close();
  }
}

export function closeSessionDatabasesForTests(): void {}
