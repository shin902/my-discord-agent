import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
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
      PRAGMA user_version = 1;
    `);
  }
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

interface LegacySessionInput {
  sessionId: string;
  file: string;
  payloads: string[];
  messages: Record<string, unknown>[];
}

async function readLegacyInputs(dir: string): Promise<LegacySessionInput[]> {
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .sort((a, b) => a.name.localeCompare(b.name));
  return Promise.all(
    files.map(async (file) => {
      const sessionId = file.name.slice(0, -".jsonl".length);
      validateName(sessionId, "セッションID");
      const filePath = path.join(dir, file.name);
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
  })();
}

function payloadPrefixMatches(
  databasePayloads: string[],
  input: LegacySessionInput,
): boolean {
  const sharedLength = Math.min(databasePayloads.length, input.payloads.length);
  return databasePayloads
    .slice(0, sharedLength)
    .every((payload, index) =>
      isDeepStrictEqual(JSON.parse(payload), input.messages[index]),
    );
}

function verifyAndReconcileLegacyInputs(
  db: Database.Database,
  inputs: LegacySessionInput[],
): void {
  const integrity = db.pragma("integrity_check", { simple: true });
  if (integrity !== "ok")
    throw new Error(`session DB integrity check failed: ${integrity}`);

  const selectPayloads = db.prepare(
    "SELECT payload_json FROM session_entries WHERE session_id=? ORDER BY sequence",
  );
  const selectSessionIds = db.prepare("SELECT id FROM sessions ORDER BY id");
  const selectExactSession = db.prepare("SELECT 1 FROM sessions WHERE id=?");
  const insertEntry = db.prepare(`
    INSERT INTO session_entries(session_id, sequence, entry_type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateSession = db.prepare(
    "UPDATE sessions SET updated_at=? WHERE id=?",
  );

  db.transaction(() => {
    for (const input of inputs) {
      const exactSession = selectExactSession.get(input.sessionId);
      let sessionId = exactSession ? input.sessionId : undefined;
      let payloads = sessionId
        ? (
            selectPayloads.all(sessionId) as Array<{ payload_json: string }>
          ).map((row) => row.payload_json)
        : [];

      if (!sessionId && input.payloads.length > 0) {
        const candidates = (
          selectSessionIds.all() as Array<{ id: string }>
        ).flatMap(({ id }) => {
          const candidatePayloads = (
            selectPayloads.all(id) as Array<{ payload_json: string }>
          ).map((row) => row.payload_json);
          return candidatePayloads.length > 0 &&
            payloadPrefixMatches(candidatePayloads, input)
            ? [{ id, payloads: candidatePayloads }]
            : [];
        });
        if (candidates.length === 1) {
          sessionId = candidates[0].id;
          payloads = candidates[0].payloads;
        }
      }

      if (!sessionId || !payloadPrefixMatches(payloads, input)) {
        throw new Error(
          `legacy session JSONLとsession DBの対応を一意に確認できません: ${input.file}`,
        );
      }

      input.messages.slice(payloads.length).forEach((message, offset) => {
        const index = payloads.length + offset;
        insertEntry.run(
          sessionId,
          index + 1,
          entryType(message),
          input.payloads[index],
          messageTimestamp(message),
        );
      });
      if (input.messages.length > payloads.length) {
        updateSession.run(
          messageTimestamp(input.messages[input.messages.length - 1]),
          sessionId,
        );
      }
    }
  })();
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
  const migrations: Array<{ inputs: LegacySessionInput[] }> = [];
  for (const groupName of groupNames) {
    validateName(groupName, "グループ名");
    const dir = await ensureDir(groupName);
    const inputs = await readLegacyInputs(dir);
    const dbPath = path.join(dir, DB_FILENAME);
    let db: Database.Database;
    if (!existsSync(dbPath)) {
      const tempPath = path.join(dir, `${DB_FILENAME}.migrating`);
      await rm(tempPath, { force: true });
      db = new Database(tempPath);
      try {
        initializeSchema(db);
        importLegacyInputs(db, inputs);
        verifyAndReconcileLegacyInputs(db, inputs);
        db.close();
        await syncPath(tempPath);
        await rename(tempPath, dbPath);
        await syncPath(dir);
        await chmod(dbPath, 0o666).catch(() => {});
        migrations.push({ inputs });
        continue;
      } catch (migrationError) {
        if (db.open) db.close();
        await rm(tempPath, { force: true });
        throw migrationError;
      }
    }
    db = new Database(dbPath, { fileMustExist: true });
    try {
      initializeSchema(db);
      verifyAndReconcileLegacyInputs(db, inputs);
      await chmod(dbPath, 0o666).catch(() => {});
      migrations.push({ inputs });
    } finally {
      db.close();
    }
  }

  const deletedDirectories = new Set<string>();
  const unlinkResults = await Promise.allSettled(
    migrations.flatMap(({ inputs }) =>
      inputs.map(async (input) => {
        await unlink(input.file);
        deletedDirectories.add(path.dirname(input.file));
      }),
    ),
  );
  const syncResults = await Promise.allSettled(
    [...deletedDirectories].map(syncPath),
  );
  const failure = [...unlinkResults, ...syncResults].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
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

export function closeSessionDatabasesForTests(): void {}
