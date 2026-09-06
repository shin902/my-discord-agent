import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_store_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

interface LegacySessionInput {
  sessionId: string;
  file: string;
  payloads: string[];
  messages: Record<string, unknown>[];
}

async function listLegacyFiles(dir: string): Promise<string[]> {
  return (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => path.join(dir, entry.name));
}

async function readLegacyInputs(dir: string): Promise<LegacySessionInput[]> {
  const files = await listLegacyFiles(dir);
  return Promise.all(
    files.map(async (filePath) => {
      const sessionId = path.basename(filePath, ".jsonl");
      validateName(sessionId, "セッションID");
      const lines = (await readFile(filePath, "utf-8"))
        .split("\n")
        .filter((line) => line.trim());
      const messages = lines.map((line, index) => {
        try {
          return sanitizeMessage(parseStoredMessage(line));
        } catch (error) {
          throw new Error(
            `legacy session JSONLの読み込みに失敗しました: ${filePath}:${index + 1}`,
            { cause: error },
          );
        }
      });
      return {
        sessionId,
        file: filePath,
        messages,
        payloads: messages.map((message) => JSON.stringify(message)),
      };
    }),
  );
}

function importLegacyInputs(
  db: Database.Database,
  inputs: LegacySessionInput[],
): void {
  const insertSession = db.prepare(
    "INSERT INTO sessions(id, created_at, updated_at) VALUES (?, ?, ?)",
  );
  const insertEntry = db.prepare(`
    INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const input of inputs) {
      const timestamps = input.messages.map(messageTimestamp);
      const createdAt = timestamps[0] ?? Date.now();
      const updatedAt = timestamps.at(-1) ?? createdAt;
      insertSession.run(input.sessionId, createdAt, updatedAt);
      input.messages.forEach((message, index) => {
        insertEntry.run(
          input.sessionId,
          index + 1,
          entryType(message),
          input.payloads[index],
          timestamps[index],
        );
      });
    }
    db.prepare(
      "INSERT OR REPLACE INTO session_store_metadata(key, value) VALUES ('legacy_jsonl_imported', '1')",
    ).run();
  })();
}

function validateExistingSchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `未対応のsession DB schema versionです: ${version} (対応: ${SCHEMA_VERSION})`,
    );
  }

  const expectedColumns: Record<
    string,
    Array<[string, string, number, string | null, number]>
  > = {
    sessions: [
      ["id", "TEXT", 0, null, 1],
      ["kind", "TEXT", 1, "'conversation'", 0],
      ["created_at", "INTEGER", 1, null, 0],
      ["updated_at", "INTEGER", 1, null, 0],
    ],
    session_entries: [
      ["id", "INTEGER", 0, null, 1],
      ["session_id", "TEXT", 1, null, 0],
      ["sequence", "INTEGER", 1, null, 0],
      ["entry_type", "TEXT", 1, null, 0],
      ["payload_json", "TEXT", 1, null, 0],
      ["created_at", "INTEGER", 1, null, 0],
    ],
    session_store_metadata: [
      ["key", "TEXT", 0, null, 1],
      ["value", "TEXT", 1, null, 0],
    ],
  };
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const actual = db.pragma(`table_info(${table})`) as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;
    const columns = actual.map(({ name, type, notnull, dflt_value, pk }) => [
      name,
      type,
      notnull,
      dflt_value,
      pk,
    ]);
    if (JSON.stringify(columns) !== JSON.stringify(expected)) {
      throw new Error(`session DB schemaが不正です: ${table} columns`);
    }
  }

  const tableSql = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='session_entries'",
    )
    .get() as { sql: string } | undefined;
  if (!tableSql?.sql.toUpperCase().includes("AUTOINCREMENT")) {
    throw new Error(
      "session DB schemaが不正です: session_entries AUTOINCREMENT",
    );
  }
  const foreignKeys = db.pragma("foreign_key_list(session_entries)") as Array<{
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }>;
  if (
    foreignKeys.length !== 1 ||
    foreignKeys[0].table !== "sessions" ||
    foreignKeys[0].from !== "session_id" ||
    foreignKeys[0].to !== "id" ||
    foreignKeys[0].on_update !== "CASCADE" ||
    foreignKeys[0].on_delete !== "CASCADE"
  ) {
    throw new Error("session DB schemaが不正です: session_entries foreign key");
  }
  const indexes = db.pragma("index_list(session_entries)") as Array<{
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }>;
  const hasIndex = (name: string, unique: number, columns: string[]) => {
    const index = indexes.find((candidate) => candidate.name === name);
    if (!index || index.unique !== unique || index.partial !== 0) return false;
    const actual = (
      db.pragma(`index_info(${name})`) as Array<{ name: string }>
    ).map((column) => column.name);
    return JSON.stringify(actual) === JSON.stringify(columns);
  };
  const hasSequenceUnique = indexes.some((index) => {
    if (index.unique !== 1 || index.origin !== "u" || index.partial !== 0)
      return false;
    const columns = (
      db.pragma(`index_info(${index.name})`) as Array<{ name: string }>
    ).map((column) => column.name);
    return (
      JSON.stringify(columns) === JSON.stringify(["session_id", "sequence"])
    );
  });
  if (
    !hasIndex("session_entries_session_id_id", 0, ["session_id", "id"]) ||
    !hasSequenceUnique
  ) {
    throw new Error("session DB schemaが不正です: session_entries indexes");
  }
  const foreignKeyFailures = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyFailures.length > 0) {
    throw new Error("session DB foreign key check failed");
  }
}

function verifyMigratedDatabase(
  db: Database.Database,
  expected?: { sessions: number; entries: number },
): void {
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok")
    throw new Error(`session DB integrity check failed: ${integrity}`);
  const marker = db
    .prepare(
      "SELECT value FROM session_store_metadata WHERE key='legacy_jsonl_imported'",
    )
    .get() as { value: string } | undefined;
  if (marker?.value !== "1") {
    throw new Error(
      "session DBに有効なlegacy JSONL migration markerがありません",
    );
  }
  if (expected) {
    const sessions = db
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .get() as { count: number };
    const entries = db
      .prepare("SELECT COUNT(*) AS count FROM session_entries")
      .get() as { count: number };
    if (
      sessions.count !== expected.sessions ||
      entries.count !== expected.entries
    ) {
      throw new Error("legacy session JSONL import件数の検証に失敗しました");
    }
  }
}

async function syncPath(target: string): Promise<void> {
  const handle = await open(target, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function migrateLegacySessionStores(
  groupNames: string[],
): Promise<void> {
  const legacyInputs: Array<{
    groupName: string;
    inputs: LegacySessionInput[];
  }> = [];
  for (const groupName of groupNames) {
    validateName(groupName, "グループ名");
    const dir = await ensureDir(groupName);
    const dbPath = path.join(dir, DB_FILENAME);
    let inputs: LegacySessionInput[];
    if (!existsSync(dbPath)) {
      inputs = await readLegacyInputs(dir);
      const tempPath = path.join(dir, `${DB_FILENAME}.migrating`);
      await rm(tempPath, { force: true });
      const db = new Database(tempPath);
      try {
        initializeSchema(db);
        importLegacyInputs(db, inputs);
        verifyMigratedDatabase(db, {
          sessions: inputs.length,
          entries: inputs.reduce(
            (sum, input) => sum + input.messages.length,
            0,
          ),
        });
        db.close();
        await syncPath(tempPath);
        await rename(tempPath, dbPath);
        await syncPath(dir);
        await chmod(dbPath, 0o666).catch(() => {});
      } catch (migrationError) {
        if (db.open) db.close();
        await rm(tempPath, { force: true });
        throw migrationError;
      }
    } else {
      const db = new Database(dbPath, { fileMustExist: true });
      try {
        validateExistingSchema(db);
        verifyMigratedDatabase(db);
        await chmod(dbPath, 0o666).catch(() => {});
      } finally {
        db.close();
      }
      inputs = (await listLegacyFiles(dir)).map((file) => ({
        sessionId: "",
        file,
        payloads: [],
        messages: [],
      }));
    }
    legacyInputs.push({ groupName, inputs });
  }

  const files = legacyInputs.flatMap(({ groupName, inputs }) =>
    inputs.map((input) => ({ groupName, source: input.file })),
  );
  if (files.length === 0) return;
  const date = new Date().toISOString().slice(0, 10);
  const batch = randomUUID();
  const backupRoot = path.join(
    path.dirname(SESSIONS_DIR),
    "session-jsonl-backup",
    date,
    batch,
  );
  for (const file of files) {
    const destinationDir = path.join(backupRoot, file.groupName);
    const destination = path.join(destinationDir, path.basename(file.source));
    try {
      await mkdir(destinationDir, { recursive: true });
      if (existsSync(destination))
        throw new Error(`backup先が既に存在します: ${destination}`);
      await rename(file.source, destination);
    } catch (error) {
      console.warn(
        `[session-migration] SQLite migrationは完了しましたが、legacy JSONLをbackupへ移動できませんでした: ${file.source}`,
        error,
      );
    }
  }
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
