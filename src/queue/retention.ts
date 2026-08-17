import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import {
  listDispatchClaims,
  resolveRssDbPath,
  tryOpenRssDb,
} from "../rss/store.js";
import type { DeliveryStatus, JobStatus } from "./repository.js";

export type RetentionStatus =
  | JobStatus
  | DeliveryStatus
  | "idempotency_key"
  | "rss_article"
  | "dead_letter";
export interface RetentionPolicy {
  /** Age in milliseconds. A missing status is retained indefinitely. */
  jobs?: Partial<Record<JobStatus, number>>;
  deliveries?: Partial<Record<DeliveryStatus, number>>;
  idempotencyKeysMs?: number;
  deadLettersMs?: number;
  rssArticlesMs?: number;
  /** Required for a non-dry prune; omitted archive output is valid for dry-run planning. */
  archiveDir?: string;
  batchSize?: number;
}
export interface RetentionPlanItem {
  kind: "job" | "delivery" | "idempotency_key" | "dead_letter" | "rss_article";
  id: string;
  status: string;
  timestamp: string;
  payloadHash: string;
  finalState: string;
  row: Record<string, unknown>;
}
export interface RetentionPlan {
  now: string;
  cutoff: Record<string, string | null>;
  items: RetentionPlanItem[];
  protected: {
    activeJobs: number;
    activeDeliveries: number;
    activeIdempotencyKeys: number;
    rssUnsettled: number;
  };
}
export interface RetentionResult {
  dryRun: boolean;
  planned: number;
  archived: number;
  deleted: number;
  archivePaths: string[];
  protected: RetentionPlan["protected"];
}

const JOB_ACTIVE = ["queued", "retry_wait", "claimed", "running"] as const;
const DELIVERY_ACTIVE = [
  "pending",
  "retry_wait",
  "sending",
  "ambiguous",
] as const;
const finiteAge = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
function cutoff(now: number, age: number | undefined): string | undefined {
  const ms = finiteAge(age);
  return ms === undefined ? undefined : new Date(now - ms).toISOString();
}
function hashPayload(row: Record<string, unknown>): string {
  const value =
    typeof row.payload_json === "string"
      ? row.payload_json
      : JSON.stringify(row);
  return createHash("sha256").update(value).digest("hex");
}
function asItem(
  kind: RetentionPlanItem["kind"],
  row: Record<string, unknown>,
  timestamp: string,
): RetentionPlanItem {
  return {
    kind,
    id: String(row.id ?? row.key),
    status: String(row.status ?? ""),
    timestamp,
    payloadHash: hashPayload(row),
    finalState: String(
      row.result_state ?? row.terminal_reason ?? row.status ?? "unknown",
    ),
    row,
  };
}
function rows(
  db: Database.Database,
  sql: string,
  ...params: unknown[]
): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

interface RssDispatchIdentity {
  statePath: string;
  dispatchId: string;
  jobId: string;
}
interface RssClaimSnapshot {
  pendingTokens: Set<string>;
  pendingJobIds: Set<string>;
  unavailablePaths: Set<string>;
}
function rssDispatchToken(dispatchId: string, jobId: string): string {
  return `${dispatchId}\u0000${jobId}`;
}
function parseRssDispatchIdentity(
  payloadJson: unknown,
  fallbackJobId?: unknown,
): RssDispatchIdentity | undefined {
  if (typeof payloadJson !== "string") return undefined;
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    const dispatchId = payload.rssDispatchId;
    const jobId = payload.idempotencyKey ?? fallbackJobId;
    if (typeof dispatchId !== "string" || typeof jobId !== "string")
      return undefined;
    const configuredPath =
      typeof payload.rssStatePath === "string" &&
      payload.rssStatePath.length > 0
        ? payload.rssStatePath
        : undefined;
    return {
      statePath: resolveRssDbPath(configuredPath),
      dispatchId,
      jobId,
    };
  } catch {
    return undefined;
  }
}
/**
 * Snapshot RSS claims before planning runtime deletes. Queue and RSS state are
 * separate databases, so a terminal RSS job must stay available whenever its
 * claim is still present (or the RSS store cannot be inspected safely).
 */
function snapshotRssClaims(
  db: Database.Database,
  rssDbPaths?: readonly string[],
): RssClaimSnapshot {
  const identities = rows(db, "SELECT payload_json,idempotency_key FROM jobs")
    .map((row) =>
      parseRssDispatchIdentity(row.payload_json, row.idempotency_key),
    )
    .filter(
      (identity): identity is RssDispatchIdentity => identity !== undefined,
    );
  const paths = new Set<string>(
    identities.map((identity) => identity.statePath),
  );
  for (const configuredPath of rssDbPaths ?? [])
    paths.add(resolveRssDbPath(configuredPath));

  const pendingTokens = new Set<string>();
  const pendingJobIds = new Set<string>();
  const unavailablePaths = new Set<string>();
  for (const statePath of paths) {
    const result = tryOpenRssDb(statePath);
    if (!result.ok) {
      if (identities.some((identity) => identity.statePath === statePath))
        unavailablePaths.add(statePath);
      continue;
    }
    try {
      for (const claim of listDispatchClaims(result.db)) {
        pendingTokens.add(
          rssDispatchToken(claim.dispatchId, claim.dispatchJobId),
        );
        pendingJobIds.add(claim.dispatchJobId);
      }
    } catch {
      // A claim whose RSS store cannot be read is safer to retain than to
      // delete: reconciliation must get a chance to inspect its evidence.
      if (identities.some((identity) => identity.statePath === statePath))
        unavailablePaths.add(statePath);
    } finally {
      result.db.close();
    }
  }
  return { pendingTokens, pendingJobIds, unavailablePaths };
}
function hasUnsettledRssClaim(
  identity: RssDispatchIdentity,
  snapshot: RssClaimSnapshot,
): boolean {
  return (
    snapshot.unavailablePaths.has(identity.statePath) ||
    snapshot.pendingTokens.has(
      rssDispatchToken(identity.dispatchId, identity.jobId),
    )
  );
}

/** Build a deterministic plan. Active rows are deliberately excluded, including ambiguous deliveries. */
export function planRetention(
  db: Database.Database,
  policy: RetentionPolicy,
  at = new Date(),
  rssDbPaths?: readonly string[],
): RetentionPlan {
  const nowMs = at.getTime();
  const items: RetentionPlanItem[] = [];
  const cutoffs: Record<string, string | null> = {};
  const jobs = policy.jobs ?? {};
  const deliveries = policy.deliveries ?? {};
  const idemCutoff = cutoff(nowMs, policy.idempotencyKeysMs);
  const rssClaimSnapshot =
    cutoff(nowMs, jobs.completed) !== undefined ||
    cutoff(nowMs, jobs.dead_letter) !== undefined ||
    idemCutoff !== undefined
      ? snapshotRssClaims(db, rssDbPaths)
      : undefined;
  const deliveryItems: RetentionPlanItem[] = [];
  for (const status of ["sent", "failed"] as const) {
    const c = cutoff(nowMs, deliveries[status]);
    cutoffs[`delivery:${status}`] = c ?? null;
    if (!c) continue;
    for (const row of rows(
      db,
      "SELECT * FROM deliveries WHERE status=? AND updated_at<? ORDER BY updated_at,id",
      status,
      c,
    )) {
      deliveryItems.push(asItem("delivery", row, String(row.updated_at)));
    }
  }
  // A terminal job may only be removed once every child delivery is itself
  // retained by this plan. Otherwise ON DELETE CASCADE would erase a newer,
  // active, or otherwise non-retained delivery without an audit export.
  const plannedDeliveryIds = new Set(deliveryItems.map((item) => item.id));
  for (const status of ["completed", "dead_letter"] as const) {
    const c = cutoff(nowMs, jobs[status]);
    cutoffs[`job:${status}`] = c ?? null;
    if (!c) continue;
    for (const row of rows(
      db,
      "SELECT * FROM jobs WHERE status=? AND updated_at<? ORDER BY updated_at,id",
      status,
      c,
    )) {
      const children = rows(
        db,
        "SELECT id FROM deliveries WHERE job_id=? ORDER BY response_index,id",
        row.id,
      );
      const rssIdentity = parseRssDispatchIdentity(
        row.payload_json,
        row.idempotency_key,
      );
      if (
        children.every((child) => plannedDeliveryIds.has(String(child.id))) &&
        (rssIdentity === undefined ||
          rssClaimSnapshot === undefined ||
          !hasUnsettledRssClaim(rssIdentity, rssClaimSnapshot))
      )
        items.push(asItem("job", row, String(row.updated_at)));
    }
  }
  // Deliveries are ordered before jobs so bounded batches can never reach a
  // parent before its planned children have been explicitly deleted.
  items.unshift(...deliveryItems);
  cutoffs.idempotency_key = idemCutoff ?? null;
  if (idemCutoff)
    for (const row of rows(
      db,
      "SELECT * FROM idempotency_keys WHERE status IN ('completed','dead_letter') AND COALESCE(completed_at,created_at)<? AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.idempotency_key=idempotency_keys.key) ORDER BY COALESCE(completed_at,created_at),key",
      idemCutoff,
    )) {
      // An orphan tombstone can still be the only queue-side evidence for a
      // pending RSS claim. Keep it until reconciliation has released/read the
      // claim; otherwise a later dedupe would lose the terminal outcome.
      if (rssClaimSnapshot?.pendingJobIds.has(String(row.key))) continue;
      items.push(
        asItem(
          "idempotency_key",
          row,
          String(row.completed_at ?? row.created_at),
        ),
      );
    }
  const deadCutoff = cutoff(nowMs, policy.deadLettersMs);
  cutoffs.dead_letter = deadCutoff ?? null;
  if (deadCutoff)
    for (const row of rows(
      db,
      "SELECT * FROM dead_letters WHERE created_at<? ORDER BY created_at,id",
      deadCutoff,
    ))
      items.push(asItem("dead_letter", row, String(row.created_at)));
  const rssCutoff = cutoff(nowMs, policy.rssArticlesMs);
  cutoffs.rss_article = rssCutoff ?? null;
  if (rssCutoff && hasTable(db, "rss_articles"))
    for (const row of staleRssArticleRows(db, rssCutoff))
      items.push(asItem("rss_article", row, String(row.read_at)));
  const protectedCounts = {
    activeJobs: rows(
      db,
      `SELECT id FROM jobs WHERE status IN (${JOB_ACTIVE.map(() => "?").join(",")})`,
      ...JOB_ACTIVE,
    ).length,
    activeDeliveries: rows(
      db,
      `SELECT id FROM deliveries WHERE status IN (${DELIVERY_ACTIVE.map(() => "?").join(",")})`,
      ...DELIVERY_ACTIVE,
    ).length,
    activeIdempotencyKeys: rows(
      db,
      "SELECT key FROM idempotency_keys WHERE status='active'",
    ).length,
    rssUnsettled: countUnsettledRssArticles(db),
  };
  return {
    now: at.toISOString(),
    cutoff: cutoffs,
    items,
    protected: protectedCounts,
  };
}
function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );
}

/** Rows eligible for RSS article pruning; unread or undispatched rows are always excluded. */
function staleRssArticleRows(
  db: Database.Database,
  cutoffAt: string,
): Record<string, unknown>[] {
  return rows(
    db,
    "SELECT * FROM rss_articles WHERE read_at IS NOT NULL AND dispatch_id IS NULL AND read_at<? ORDER BY read_at,id",
    cutoffAt,
  );
}
/** RSS articles protected from pruning: unread, or dispatched while delivery is still pending. */
function countUnsettledRssArticles(db: Database.Database): number {
  return hasTable(db, "rss_articles")
    ? rows(
        db,
        "SELECT id FROM rss_articles WHERE read_at IS NULL OR dispatch_id IS NOT NULL",
      ).length
    : 0;
}

async function archiveItems(
  items: RetentionPlanItem[],
  archiveDir: string,
  at: string,
  batch: number,
): Promise<string[]> {
  await mkdir(archiveDir, { recursive: true });
  const paths: string[] = [];
  for (let offset = 0; offset < items.length; offset += batch) {
    const chunk = items.slice(offset, offset + batch);
    const stamp = at.replace(/[:.]/g, "-");
    const target = path.join(
      archiveDir,
      `runtime-retention-${stamp}-${offset / batch}-${randomUUID()}.jsonl`,
    );
    const body = `${chunk.map((item) => JSON.stringify({ version: 1, exportedAt: at, ...item })).join("\n")}\n`;
    let created = false;
    try {
      // wx makes the destination exclusive, so a repeated timestamp or a shared
      // archive directory can never replace an earlier export.
      await writeFile(target, body, { encoding: "utf8", flag: "wx" });
      created = true;
      const verified = await readFile(target, "utf8");
      if (verified !== body)
        throw new Error(`retention archive verification failed: ${target}`);
      paths.push(target);
    } catch (error) {
      // The caller must never delete rows after an incomplete preflight. Remove
      // every archive produced by this invocation, including earlier batches.
      await Promise.allSettled(
        [...paths, ...(created ? [target] : [])].map((archivePath) =>
          rm(archivePath, { force: true }),
        ),
      );
      throw error;
    }
  }
  return paths;
}

function deleteRssArticleRow(
  db: Database.Database,
  item: RetentionPlanItem,
): number {
  return db
    .prepare(
      "DELETE FROM rss_articles WHERE id=? AND read_at IS NOT NULL AND dispatch_id IS NULL",
    )
    .run(Number(item.id)).changes;
}
function deleteRetentionItem(
  db: Database.Database,
  kind: RetentionPlanItem["kind"],
  item: RetentionPlanItem,
): number {
  if (kind === "job")
    return db
      .prepare(
        "DELETE FROM jobs WHERE id=? AND status IN ('completed','dead_letter') AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.job_id=jobs.id)",
      )
      .run(item.id).changes;
  if (kind === "delivery")
    return db
      .prepare(
        "DELETE FROM deliveries WHERE id=? AND status IN ('sent','failed')",
      )
      .run(item.id).changes;
  if (kind === "idempotency_key")
    return db
      .prepare(
        "DELETE FROM idempotency_keys WHERE key=? AND status IN ('completed','dead_letter') AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.idempotency_key=idempotency_keys.key)",
      )
      .run(item.id).changes;
  if (kind === "dead_letter")
    return db
      .prepare("DELETE FROM dead_letters WHERE id=?")
      .run(Number(item.id)).changes;
  return deleteRssArticleRow(db, item);
}

/**
 * Delete each batch transactionally, children before parents so a job is never
 * removed while a newer, active, or non-retained delivery could cascade. RSS
 * plans only ever carry rss_article items, so this single loop also covers the
 * RSS path without duplicating per-kind SQL.
 */
function deleteRetentionBatch(
  db: Database.Database,
  items: RetentionPlanItem[],
): number {
  return db.transaction(() => {
    let count = 0;
    for (const kind of [
      "delivery",
      "rss_article",
      "dead_letter",
      "idempotency_key",
      "job",
    ] as const) {
      for (const item of items.filter((entry) => entry.kind === kind)) {
        count += deleteRetentionItem(db, kind, item);
      }
    }
    return count;
  })();
}

interface PrunePlan {
  now: string;
  items: RetentionPlanItem[];
  protected: RetentionPlan["protected"];
}

/**
 * Shared retire-and-prune orchestration for the runtime and RSS stores:
 * dry-run reporting, archive-dir preflight, empty-plan short-circuit, the
 * archive-first invariant, bounded per-batch deletes, and result composition.
 */
async function runRetentionPrune(
  db: Database.Database,
  policy: RetentionPolicy,
  options: { at?: Date; dryRun?: boolean },
  plan: PrunePlan,
  deleteBatch: (db: Database.Database, items: RetentionPlanItem[]) => number,
): Promise<RetentionResult> {
  if (options.dryRun)
    return {
      dryRun: true,
      planned: plan.items.length,
      archived: 0,
      deleted: 0,
      archivePaths: [],
      protected: plan.protected,
    };
  if (!policy.archiveDir)
    throw new Error("retention archiveDir is required for pruning");
  if (plan.items.length === 0)
    return {
      dryRun: false,
      planned: 0,
      archived: 0,
      deleted: 0,
      archivePaths: [],
      protected: plan.protected,
    };
  const batchSize = Math.max(1, Math.floor(policy.batchSize ?? 100));
  // Invariant: archive and verify ALL batches before the FIRST delete. If a
  // later batch fails, archiveItems removes every earlier export and all rows
  // remain untouched, so the audit trail always covers the data being removed.
  const archivePaths = await archiveItems(
    plan.items,
    policy.archiveDir,
    plan.now,
    batchSize,
  );
  let deleted = 0;
  for (let offset = 0; offset < plan.items.length; offset += batchSize) {
    deleted += deleteBatch(db, plan.items.slice(offset, offset + batchSize));
  }
  return {
    dryRun: false,
    planned: plan.items.length,
    archived: plan.items.length,
    deleted,
    archivePaths,
    protected: plan.protected,
  };
}

/** Export all batches first, then delete each bounded batch in its own transaction. */
export async function pruneRetention(
  db: Database.Database,
  policy: RetentionPolicy,
  options: {
    at?: Date;
    dryRun?: boolean;
    /** RSS stores known by the caller but not present in queue payloads. */
    rssDbPaths?: readonly string[];
  } = {},
): Promise<RetentionResult> {
  const plan = planRetention(
    db,
    policy,
    options.at ?? new Date(),
    options.rssDbPaths,
  );
  return runRetentionPrune(db, policy, options, plan, deleteRetentionBatch);
}

export interface RssRetentionPlan {
  now: string;
  items: RetentionPlanItem[];
  protected: number;
}

/** Plan RSS article pruning on the separate rss.sqlite database. Unread or dispatched rows are protected. */
export function planRssRetention(
  db: Database.Database,
  policy: RetentionPolicy,
  at = new Date(),
): RssRetentionPlan {
  const age = cutoff(at.getTime(), policy.rssArticlesMs);
  if (!age || !hasTable(db, "rss_articles"))
    return {
      now: at.toISOString(),
      items: [],
      protected: countUnsettledRssArticles(db),
    };
  const items = staleRssArticleRows(db, age).map((row) =>
    asItem("rss_article", row, String(row.read_at)),
  );
  const protectedCount = countUnsettledRssArticles(db);
  return { now: at.toISOString(), items, protected: protectedCount };
}

export async function pruneRssRetention(
  db: Database.Database,
  policy: RetentionPolicy,
  options: { at?: Date; dryRun?: boolean } = {},
): Promise<RetentionResult> {
  const plan = planRssRetention(db, policy, options.at ?? new Date());
  return runRetentionPrune(
    db,
    policy,
    options,
    {
      now: plan.now,
      items: plan.items,
      protected: {
        activeJobs: 0,
        activeDeliveries: 0,
        activeIdempotencyKeys: 0,
        rssUnsettled: plan.protected,
      },
    },
    deleteRetentionBatch,
  );
}
