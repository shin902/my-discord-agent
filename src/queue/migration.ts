import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InboxMessage } from "./inbox.js";
import { QueueRepository, type LegacyMigrationResult } from "./repository.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LEGACY_DIR = path.join(ROOT, "data/queue");
const inboxPath = path.join(LEGACY_DIR, "inbox.jsonl");
const deadLetterPath = path.join(LEGACY_DIR, "dead-letter.jsonl");

async function backupLegacyFile(source: string, archiveDir: string, bytes: Buffer): Promise<string> {
  await mkdir(archiveDir, { recursive: true });
  const stem = path.join(archiveDir, `${path.basename(source)}.${Date.now()}`);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const destination = `${stem}${attempt === 0 ? "" : `-${attempt}`}.bak`;
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await chmod(destination, 0o444);
    if (!bytes.equals(await readFile(destination))) throw new Error(`legacy backup verification failed: ${source}`);
    return destination;
  }
  throw new Error(`unable to allocate legacy backup path: ${source}`);
}

function validMessage(value: unknown): value is InboxMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<InboxMessage>;
  if (
    typeof message.id !== "string" ||
    typeof message.channelId !== "string" ||
    typeof message.groupName !== "string" ||
    typeof message.sessionId !== "string" ||
    typeof message.content !== "string" ||
    typeof message.timestamp !== "string"
  ) return false;
  if (message.enqueuedAt !== undefined && typeof message.enqueuedAt !== "string") return false;
  if (message.retries !== undefined && (!Number.isInteger(message.retries) || message.retries < 0)) return false;
  for (const optional of [message.messageId, message.idempotencyKey, message.completedAt, message.cronJobId, message.cronThreadId, message.rssDispatchId, message.rssStatePath]) {
    if (optional !== undefined && typeof optional !== "string") return false;
  }
  if (message.cronDeliveryMode !== undefined && message.cronDeliveryMode !== "direct" && message.cronDeliveryMode !== "new-thread") return false;
  if (message.cronSessionMode !== undefined && message.cronSessionMode !== "per-run" && message.cronSessionMode !== "destination") return false;
  if (message.cronThread !== undefined && typeof message.cronThread !== "boolean") return false;
  if (message.attachments !== undefined) {
    if (!Array.isArray(message.attachments)) return false;
    if (message.attachments.some((attachment) =>
      !attachment ||
      typeof attachment.url !== "string" ||
      typeof attachment.name !== "string" ||
      (attachment.contentType !== null && typeof attachment.contentType !== "string") ||
      !Number.isInteger(attachment.size) ||
      attachment.size < 0
    )) return false;
  }
  if (message.configOverride !== undefined) {
    const override = message.configOverride;
    if (!override || typeof override !== "object" || Array.isArray(override)) return false;
    if (override.tools !== undefined && (!Array.isArray(override.tools) || override.tools.some((tool) => typeof tool !== "string"))) return false;
    if (override.skills !== undefined && override.skills !== "*" && (!Array.isArray(override.skills) || override.skills.some((skill) => typeof skill !== "string"))) return false;
    if (override.model !== undefined) {
      const model = override.model;
      if (!model || typeof model !== "object" || Array.isArray(model) || typeof model.provider !== "string" || typeof model.modelId !== "string") return false;
      if (model.thinkingLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(model.thinkingLevel)) return false;
    }
  }
  return true;
}

export interface LegacyQueuePaths {
  inboxPath?: string;
  deadLetterPath?: string;
  archiveDir?: string;
}

export async function migrateLegacyQueue(repo: QueueRepository = new QueueRepository(), paths: LegacyQueuePaths = {}): Promise<LegacyMigrationResult> {
  const legacyInboxPath = paths.inboxPath ?? inboxPath;
  const legacyDeadLetterPath = paths.deadLetterPath ?? deadLetterPath;
  const result: LegacyMigrationResult = { migrated: 0, completed: 0, malformed: 0, deadLetters: 0, backupPaths: [] };
  const archiveDir = paths.archiveDir ?? path.join(LEGACY_DIR, "archive");
  for (const [source, kind] of [[legacyInboxPath, "inbox"], [legacyDeadLetterPath, "dead"]] as const) {
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const marker = `legacy_migration:${path.basename(source)}:${digest}`;
    if (repo.db.prepare("SELECT 1 FROM schema_meta WHERE key=?").get(marker)) continue;
    const backupPath = await backupLegacyFile(source, archiveDir, bytes);
    const migratedFile = repo.db.transaction(() => {
      if (repo.db.prepare("SELECT 1 FROM schema_meta WHERE key=?").get(marker)) return false;
      for (const raw of bytes.toString("utf8").split(/\r?\n/)) {
        if (!raw.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          repo.recordDeadLetter({ reason: "malformed_jsonl", payloadJson: null, error: raw, source: "migration" });
          result.malformed++;
          continue;
        }
        if (kind === "dead") {
          repo.recordDeadLetter({ reason: "legacy_dead_letter", payloadJson: raw, source: "migration" });
          result.deadLetters++;
          continue;
        }
        if (!validMessage(value)) {
          repo.recordDeadLetter({ reason: "invalid_inbox_row", payloadJson: raw, source: "migration" });
          result.malformed++;
          continue;
        }
        const message = value;
        if (message.completedAt) {
          if (message.idempotencyKey) {
            repo.db.prepare("INSERT INTO idempotency_keys(key,job_id,status,created_at,completed_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status='completed',completed_at=excluded.completed_at").run(message.idempotencyKey, null, "completed", message.enqueuedAt ?? message.timestamp, message.completedAt);
          } else {
            repo.recordDeadLetter({ reason: "completed_without_idempotency_key", payloadJson: raw, source: "migration" });
          }
          result.completed++;
          continue;
        }
        const existing = repo.get(message.id);
        if (!existing) {
          const key = message.idempotencyKey;
          const duplicate = key ? repo.findByIdempotencyKey(key) : undefined;
          if (!duplicate) {
            const timestamp = message.enqueuedAt ?? message.timestamp;
            repo.db.prepare("INSERT INTO jobs(id,idempotency_key,payload_json,status,attempts,max_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(message.id, key ?? null, JSON.stringify({ ...message, retries: message.retries ?? 0 }), "queued", message.retries ?? 0, 10, timestamp, timestamp);
            if (key) repo.db.prepare("INSERT OR IGNORE INTO idempotency_keys(key,job_id,status,created_at) VALUES(?,?,?,?)").run(key, message.id, "active", timestamp);
            result.migrated++;
          }
        }
      }
      repo.db.prepare("INSERT INTO schema_meta(key,value) VALUES(?,?)").run(marker, digest);
      return true;
    })();
    if (migratedFile) result.backupPaths.push(backupPath);
  }
  return result;
}

export async function initializeQueue(repo: QueueRepository): Promise<LegacyMigrationResult> {
  repo.requeueExpired();
  return migrateLegacyQueue(repo);
}
