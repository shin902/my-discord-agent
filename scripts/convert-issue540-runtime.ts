import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { QueueRepository } from "../src/queue/repository.js";

const MARKER = "issue540:source-envelope";

type Payload = Record<string, unknown>;
function parsePayload(text: string): Payload {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected a JSON object in the runtime payload");
  return value as Payload;
}

function convertPayload(payload: Payload, dispatchJobId?: string): {
  payload: Payload;
  kind: string | null;
  continueAfterFailedChunk: number;
} {
  const next = { ...payload };
  const mail = next.mailEmailId;
  const rss = next.rssDispatchId;
  if (mail !== undefined && rss !== undefined)
    throw new Error("queue payload has both Mail and RSS source IDs");
  if (next.feature !== undefined)
    throw new Error("queue source envelope was already converted");
  let kind: string | null = null;
  if (mail !== undefined) {
    if (typeof mail !== "string" || !mail)
      throw new Error("invalid Mail email ID");
    const routeKey = next.mailRouteKey;
    if (routeKey !== undefined && typeof routeKey !== "string")
      throw new Error("invalid Mail route key");
    next.feature = {
      kind: "mail",
      input: { emailId: mail, ...(routeKey !== undefined ? { routeKey } : {}) },
    };
    delete next.mailEmailId;
    delete next.mailRouteKey;
    kind = "mail";
  } else if (rss !== undefined) {
    if (typeof rss !== "string" || !rss)
      throw new Error("invalid RSS dispatch ID");
    const statePath = next.rssStatePath;
    const key = next.rssDispatchJobId ?? dispatchJobId;
    if (statePath !== undefined && typeof statePath !== "string")
      throw new Error("invalid RSS state path");
    if (key !== undefined && typeof key !== "string")
      throw new Error("invalid RSS dispatch job key");
    next.feature = {
      kind: "rss",
      input: {
        dispatchId: rss,
        ...(statePath !== undefined ? { statePath } : {}),
        ...(key !== undefined ? { dispatchJobId: key } : {}),
      },
    };
    delete next.rssDispatchId;
    delete next.rssStatePath;
    delete next.rssDispatchJobId;
    kind = "rss";
  }
  return { payload: next, kind, continueAfterFailedChunk: kind === "rss" ? 1 : 0 };
}

/** Must run only while the old worker is stopped; never runs at normal startup. */
export async function convertIssue540Runtime(
  repo: QueueRepository,
): Promise<void> {
  if (repo.db.prepare("SELECT 1 FROM schema_meta WHERE key=?").get(MARKER))
    throw new Error("Issue #540 runtime conversion has already been applied");
  const db: Database.Database = repo.db;
  db.transaction(() => {
    const updateJob = db.prepare(
      "UPDATE jobs SET payload_json=?,source_kind=?,allow_failed_predecessor=? WHERE id=?",
    );
    for (const row of db
      .prepare("SELECT id,payload_json,idempotency_key FROM jobs")
      .all() as Array<{ id: string; payload_json: string; idempotency_key: string | null }>) {
      const converted = convertPayload(parsePayload(row.payload_json), row.idempotency_key ?? undefined);
      if (!converted.kind) continue;
      updateJob.run(
        JSON.stringify(converted.payload),
        converted.kind,
        converted.continueAfterFailedChunk,
        row.id,
      );
    }
    const updateDelivery = db.prepare("UPDATE deliveries SET payload_json=? WHERE id=?");
    for (const row of db
      .prepare("SELECT id,payload_json FROM deliveries WHERE payload_json IS NOT NULL")
      .all() as Array<{ id: string; payload_json: string }>) {
      const converted = convertPayload(parsePayload(row.payload_json));
      if (converted.kind) updateDelivery.run(JSON.stringify(converted.payload), row.id);
    }
    const updateLetter = db.prepare("UPDATE dead_letters SET payload_json=? WHERE id=?");
    for (const row of db
      .prepare("SELECT id,payload_json FROM dead_letters WHERE payload_json IS NOT NULL")
      .all() as Array<{ id: number; payload_json: string }>) {
      // Invalid legacy rows are themselves diagnostic dead letters, not queue
      // work. Preserve their raw payload instead of aborting the conversion.
      try {
        const converted = convertPayload(parsePayload(row.payload_json));
        if (converted.kind) updateLetter.run(JSON.stringify(converted.payload), row.id);
      } catch {
        // A malformed dead letter is diagnostic evidence, never executable.
        // Preserve it byte-for-byte instead of blocking valid queue work.
      }
    }
    db.prepare("INSERT INTO schema_meta(key,value) VALUES(?,?)").run(MARKER, new Date().toISOString());
  })();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dbPath = process.argv[2];
  if (!dbPath || process.argv[3])
    throw new Error("usage: tsx scripts/convert-issue540-runtime.ts <runtime.sqlite>");
  const repo = new QueueRepository(resolve(dbPath));
  try {
    await convertIssue540Runtime(repo);
  } finally {
    repo.close();
  }
}
