import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelConfigSchema, SkillSelectionSchema } from "../config/groups.js";
import { z } from "zod";
import { type LegacyMigrationResult, QueueRepository } from "./repository.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const LEGACY_DIR = path.join(ROOT, "data/queue");
const inboxPath = path.join(LEGACY_DIR, "inbox.jsonl");
const deadLetterPath = path.join(LEGACY_DIR, "dead-letter.jsonl");

async function backupLegacyFile(
  source: string,
  archiveDir: string,
  bytes: Buffer,
): Promise<string> {
  await mkdir(archiveDir, { recursive: true });
  const stem = path.join(archiveDir, `${path.basename(source)}.${Date.now()}`);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const destination = `${stem}${attempt === 0 ? "" : `-${attempt}`}.bak`;
    try {
      await copyFile(source, destination, constants.COPYFILE_EXCL);
    } catch (error) {
      if (z.object({ code: z.literal("EEXIST") }).safeParse(error).success)
        continue;
      throw error;
    }
    await chmod(destination, 0o444);
    if (!bytes.equals(await readFile(destination)))
      throw new Error(`legacy backup verification failed: ${source}`);
    return destination;
  }
  throw new Error(`unable to allocate legacy backup path: ${source}`);
}

const LegacyMessageSchema = z
  .object({
    id: z.string(),
    channelId: z.string(),
    groupName: z.string(),
    sessionId: z.string(),
    messageId: z.string().optional(),
    content: z.string(),
    timestamp: z.string(),
    enqueuedAt: z.string().optional(),
    retries: z.number().int().nonnegative().default(0),
    idempotencyKey: z.string().optional(),
    completedAt: z.string().optional(),
    cronDeliveryMode: z.enum(["direct", "new-thread"]).optional(),
    cronSessionMode: z.enum(["per-run", "destination"]).optional(),
    cronThread: z.boolean().optional(),
    cronJobId: z.string().optional(),
    cronThreadId: z.string().optional(),
    rssDispatchId: z.string().optional(),
    rssStatePath: z.string().optional(),
    configOverride: z
      .object({
        model: ModelConfigSchema.optional(),
        tools: z.array(z.string()).optional(),
        skills: SkillSelectionSchema.optional(),
      })
      .optional(),
    attachments: z
      .array(
        z.object({
          url: z.string(),
          name: z.string(),
          contentType: z.string().nullable(),
          size: z.number().int().nonnegative(),
        }),
      )
      .optional(),
    agentsSnapshotContent: z.string().optional(),
    memorySnapshotContent: z.string().optional(),
    agentsSnapshotPresent: z.boolean().optional(),
    memorySnapshotPresent: z.boolean().optional(),
    snapshotPresent: z.boolean().optional(),
    snapshotHash: z.string().optional(),
    toolCallKey: z.string().optional(),
    fencingToken: z.number().optional(),
    workerId: z.string().optional(),
    lastError: z.string().optional(),
  })
  .passthrough();

export interface LegacyQueuePaths {
  inboxPath?: string;
  deadLetterPath?: string;
  archiveDir?: string;
}

export async function migrateLegacyQueue(
  repo: QueueRepository = new QueueRepository(),
  paths: LegacyQueuePaths = {},
): Promise<LegacyMigrationResult> {
  const legacyInboxPath = paths.inboxPath ?? inboxPath;
  const legacyDeadLetterPath = paths.deadLetterPath ?? deadLetterPath;
  const result: LegacyMigrationResult = {
    migrated: 0,
    completed: 0,
    malformed: 0,
    deadLetters: 0,
    backupPaths: [],
  };
  const archiveDir = paths.archiveDir ?? path.join(LEGACY_DIR, "archive");
  for (const [source, kind] of [
    [legacyInboxPath, "inbox"],
    [legacyDeadLetterPath, "dead"],
  ] as const) {
    let bytes: Buffer;
    try {
      bytes = await readFile(source);
    } catch (error) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
        continue;
      throw error;
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const marker = `legacy_migration:${path.basename(source)}:${digest}`;
    if (repo.db.prepare("SELECT 1 FROM schema_meta WHERE key=?").get(marker))
      continue;
    const backupPath = await backupLegacyFile(source, archiveDir, bytes);
    const migratedFile = repo.db.transaction(() => {
      if (repo.db.prepare("SELECT 1 FROM schema_meta WHERE key=?").get(marker))
        return false;
      for (const raw of bytes.toString("utf8").split(/\r?\n/)) {
        if (!raw.trim()) continue;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          repo.recordDeadLetter({
            reason: "malformed_jsonl",
            payloadJson: null,
            error: raw,
            source: "migration",
          });
          result.malformed++;
          continue;
        }
        if (kind === "dead") {
          repo.recordDeadLetter({
            reason: "legacy_dead_letter",
            payloadJson: raw,
            source: "migration",
          });
          result.deadLetters++;
          continue;
        }
        const parsedMessage = LegacyMessageSchema.safeParse(value);
        if (!parsedMessage.success) {
          repo.recordDeadLetter({
            reason: "invalid_inbox_row",
            payloadJson: raw,
            source: "migration",
          });
          result.malformed++;
          continue;
        }
        const identity = parsedMessage.data;
        const hasIdentity =
          identity.agentsSnapshotContent !== undefined ||
          identity.memorySnapshotContent !== undefined ||
          identity.snapshotHash !== undefined ||
          identity.toolCallKey !== undefined ||
          identity.agentsSnapshotPresent !== undefined ||
          identity.memorySnapshotPresent !== undefined ||
          identity.snapshotPresent !== undefined;
        const invalidIdentityTypes = false;
        const incoherentIdentity =
          (hasIdentity &&
            (identity.agentsSnapshotPresent === undefined ||
              identity.memorySnapshotPresent === undefined)) ||
          (identity.agentsSnapshotContent !== undefined &&
            identity.agentsSnapshotPresent !== true) ||
          (identity.memorySnapshotContent !== undefined &&
            identity.memorySnapshotPresent !== true) ||
          (identity.agentsSnapshotPresent === true &&
            identity.agentsSnapshotContent === undefined) ||
          (identity.memorySnapshotPresent === true &&
            identity.memorySnapshotContent === undefined) ||
          (identity.snapshotPresent !== undefined &&
            (identity.snapshotHash === undefined ||
              identity.snapshotHash.length === 0)) ||
          (identity.snapshotPresent !== undefined &&
            identity.snapshotPresent !==
              (identity.agentsSnapshotPresent === true ||
                identity.memorySnapshotPresent === true)) ||
          (identity.snapshotHash !== undefined &&
            identity.snapshotPresent === undefined) ||
          (identity.toolCallKey !== undefined &&
            identity.toolCallKey.length === 0);
        if (invalidIdentityTypes || incoherentIdentity) {
          repo.recordDeadLetter({
            reason: invalidIdentityTypes
              ? "invalid_execution_identity"
              : "incoherent_execution_identity",
            payloadJson: raw,
            source: "migration",
          });
          result.malformed++;
          continue;
        }
        const message = parsedMessage.data;
        if (message.completedAt) {
          if (message.idempotencyKey) {
            repo.db
              .prepare(
                "INSERT INTO idempotency_keys(key,job_id,status,created_at,completed_at) VALUES(?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET status='completed',completed_at=excluded.completed_at",
              )
              .run(
                message.idempotencyKey,
                null,
                "completed",
                message.enqueuedAt ?? message.timestamp,
                message.completedAt,
              );
          } else {
            repo.recordDeadLetter({
              reason: "completed_without_idempotency_key",
              payloadJson: raw,
              source: "migration",
            });
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
            // Normal enqueue numbers the first row of an empty session 0; mirror
            // that exactly so migrated and enqueued sessions share one ordering.
            const sequenceRow = z
              .object({ sequence: z.number() })
              .parse(
                repo.db
                  .prepare(
                    "SELECT COALESCE(MAX(sequence),-1)+1 AS sequence FROM jobs WHERE session_id=?",
                  )
                  .get(message.sessionId),
              );
            repo.db
              .prepare(
                "INSERT INTO jobs(id,idempotency_key,payload_json,session_id,sequence,status,attempts,max_attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                message.id,
                key ?? null,
                JSON.stringify({ ...message, retries: message.retries ?? 0 }),
                message.sessionId,
                sequenceRow.sequence,
                "queued",
                message.retries ?? 0,
                10,
                timestamp,
                timestamp,
              );
            if (key) {
              repo.db
                .prepare(
                  "INSERT OR IGNORE INTO idempotency_keys(key,job_id,status,created_at) VALUES(?,?,?,?)",
                )
                .run(key, message.id, "active", timestamp);
            }
            result.migrated++;
          }
        }
      }
      repo.db
        .prepare("INSERT INTO schema_meta(key,value) VALUES(?,?)")
        .run(marker, digest);
      return true;
    })();
    if (migratedFile) result.backupPaths.push(backupPath);
  }
  return result;
}

export async function initializeQueue(
  repo: QueueRepository,
): Promise<LegacyMigrationResult> {
  repo.recoverExpired();
  return migrateLegacyQueue(repo);
}
