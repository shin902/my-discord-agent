import type Database from "better-sqlite3";
import { inspectRssReconciliation } from "../rss/observability.js";
import { z } from "zod";
export interface LatencyPercentiles {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
}
export interface QueueMetrics {
  byStatus: Record<string, number>;
  latencyMs: LatencyPercentiles;
  staleClaims: number;
}
export interface DeliveryMetrics {
  byStatus: Record<string, number>;
  latencyMs: LatencyPercentiles;
  ambiguous: number;
  staleClaims: number;
}
export interface AgentMetrics {
  jobs: number;
  completed: number;
  failed: number;
  emptyResponses: number;
  averageAttempts: number;
  latencyMs: LatencyPercentiles;
}
export interface RssPathMetrics {
  feeds: number;
  articles: number;
  unread: number;
  claimed: number;
  orphanDispatches: string[];
  tombstones: string[];
  migrationAnomalies: Array<{
    dispatchId: string;
    jobId: string | null;
    articleIds: number[];
    reason: string;
  }>;
}
export interface RssMetrics extends RssPathMetrics {
  byPath: Record<string, RssPathMetrics>;
  errors: Array<{ path: string; error: string }>;
}
export interface RssDbInspection {
  path: string;
  db: Database.Database;
}
export interface ObservabilitySnapshot {
  at: string;
  queue: QueueMetrics;
  delivery: DeliveryMetrics;
  agent: AgentMetrics;
  rss: RssMetrics | null;
  alerts: string[];
}
export interface OperatorJob {
  id: string;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_until: string | null;
  worker_id: string | null;
  last_error: string | null;
  updated_at: string;
  result_state: string | null;
}
export interface OperatorDelivery {
  id: string;
  job_id: string;
  status: string;
  attempts: number;
  lease_until: string | null;
  worker_id: string | null;
  last_error: string | null;
  updated_at: string;
}
export interface OperatorDeadLetter {
  id: string;
  job_id: string;
  reason: string;
  error: string;
  source: string;
  created_at: string;
}
export interface OperatorInspection {
  jobs: OperatorJob[];
  deliveries: OperatorDelivery[];
  deadLetters: OperatorDeadLetter[];
  rss: RssMetrics | null;
  alerts: string[];
}

function percentiles(values: number[]): LatencyPercentiles {
  if (values.length === 0) return { count: 0, p50: null, p95: null, p99: null };
  values.sort((a, b) => a - b);
  const pick = (fraction: number): number =>
    values[
      Math.min(
        values.length - 1,
        Math.max(0, Math.ceil(values.length * fraction) - 1),
      )
    ];
  return {
    count: values.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
  };
}
const AgeRowSchema = z.object({
  start: z.string(),
  finish: z.string().nullable(),
});
const CountRowSchema = z.object({
  status: z.string(),
  count: z.number(),
});
const AgentRowSchema = z.object({
  jobs: z.number(),
  completed: z.number().nullable(),
  failed: z.number().nullable(),
  empty_responses: z.number().nullable(),
  average_attempts: z.number(),
});

function ageValues(db: Database.Database, sql: string): number[] {
  return z.array(AgeRowSchema).parse(db.prepare(sql).all()).flatMap((row) => {
    const start = Date.parse(row.start);
    const finish = row.finish ? Date.parse(row.finish) : NaN;
    return Number.isFinite(start) && Number.isFinite(finish)
      ? [Math.max(0, finish - start)]
      : [];
  });
}
function counts(db: Database.Database, table: string) {
  const result: { [status: string]: number } = {};
  const rows = z
    .array(CountRowSchema)
    .parse(
      db.prepare(`SELECT status,COUNT(*) AS count FROM ${table} GROUP BY status`).all(),
    );
  for (const row of rows) result[row.status] = row.count;
  return result;
}
function rssMetrics(
  rssDb: Database.Database,
  runtimeDb: Database.Database,
): RssPathMetrics {
  const report = inspectRssReconciliation(rssDb, runtimeDb);
  return {
    feeds: report.feeds,
    articles: report.articles,
    unread: report.unread,
    claimed: report.claimed,
    orphanDispatches: report.orphanDispatches.map((entry) => entry.jobId),
    tombstones: report.completedTombstones.map((entry) => entry.jobId),
    migrationAnomalies: report.migrationAnomalies,
  };
}

function aggregateRssMetrics(
  entries: readonly RssDbInspection[],
  runtimeDb: Database.Database,
  errors: readonly { path: string; error: string }[],
): RssMetrics | null {
  if (entries.length === 0 && errors.length === 0) return null;
  const byPath: Record<string, RssPathMetrics> = {};
  const aggregate: RssPathMetrics = {
    feeds: 0,
    articles: 0,
    unread: 0,
    claimed: 0,
    orphanDispatches: [],
    tombstones: [],
    migrationAnomalies: [],
  };
  for (const entry of entries) {
    const metrics = rssMetrics(entry.db, runtimeDb);
    byPath[entry.path] = metrics;
    aggregate.feeds += metrics.feeds;
    aggregate.articles += metrics.articles;
    aggregate.unread += metrics.unread;
    aggregate.claimed += metrics.claimed;
    aggregate.orphanDispatches.push(...metrics.orphanDispatches);
    aggregate.tombstones.push(...metrics.tombstones);
    aggregate.migrationAnomalies.push(...metrics.migrationAnomalies);
  }
  return { ...aggregate, byPath, errors: [...errors] };
}

/** Collect queue, delivery, agent, and RSS metrics without mixing their cardinalities. */
export function collectObservability(
  runtimeDb: Database.Database,
  rssDb?: Database.Database,
  options: {
    at?: Date;
    staleAfterMs?: number;
    rssDbs?: readonly RssDbInspection[];
    rssErrors?: readonly { path: string; error: string }[];
  } = {},
): ObservabilitySnapshot {
  const at = options.at ?? new Date();
  const now = at.getTime();
  const staleAfter =
    options.staleAfterMs !== undefined &&
    Number.isFinite(options.staleAfterMs) &&
    options.staleAfterMs >= 0
      ? options.staleAfterMs
      : 60_000;
  const staleBefore = new Date(now - staleAfter).toISOString();
  const queue = {
    byStatus: counts(runtimeDb, "jobs"),
    latencyMs: percentiles(
      ageValues(
        runtimeDb,
        "SELECT created_at AS start,completed_at AS finish FROM jobs WHERE completed_at IS NOT NULL",
      ),
    ),
    staleClaims: Number(
      z.object({ count: z.number() }).parse(
        runtimeDb
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('claimed','running') AND lease_until IS NOT NULL AND lease_until<?",
          )
          .get(staleBefore),
      ).count,
    ),
  };
  const delivery = {
    byStatus: counts(runtimeDb, "deliveries"),
    latencyMs: percentiles(
      ageValues(
        runtimeDb,
        "SELECT created_at AS start,updated_at AS finish FROM deliveries WHERE status IN ('sent','failed')",
      ),
    ),
    ambiguous: Number(
      z.object({ count: z.number() }).parse(
        runtimeDb
          .prepare(
            "SELECT COUNT(*) AS count FROM deliveries WHERE status='ambiguous'",
          )
          .get(),
      ).count,
    ),
    staleClaims: Number(
      z.object({ count: z.number() }).parse(
        runtimeDb
          .prepare(
            "SELECT COUNT(*) AS count FROM deliveries WHERE status='sending' AND lease_until IS NOT NULL AND lease_until<?",
          )
          .get(staleBefore),
      ).count,
    ),
  };
  const agentRowsRaw = runtimeDb
    .prepare(
      "SELECT COUNT(*) AS jobs,SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,SUM(CASE WHEN status='dead_letter' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN result_state='empty_response' THEN 1 ELSE 0 END) AS empty_responses,COALESCE(AVG(attempts),0) AS average_attempts FROM jobs",
    )
    .get();
  const agentRows = AgentRowSchema.parse(agentRowsRaw);
  const agent: AgentMetrics = {
    jobs: Number(agentRows.jobs),
    completed: Number(agentRows.completed ?? 0),
    failed: Number(agentRows.failed ?? 0),
    emptyResponses: Number(agentRows.empty_responses ?? 0),
    averageAttempts: Number(agentRows.average_attempts ?? 0),
    latencyMs: queue.latencyMs,
  };
  const rssEntries =
    options.rssDbs ?? (rssDb ? [{ path: "provided", db: rssDb }] : []);
  const rss = aggregateRssMetrics(
    rssEntries,
    runtimeDb,
    options.rssErrors ?? [],
  );
  const alerts: string[] = [];
  if (queue.staleClaims > 0)
    alerts.push(
      `stale queue claims (lease expired > ${staleAfter}ms): ${queue.staleClaims}`,
    );
  if (delivery.staleClaims > 0)
    alerts.push(
      `stale delivery claims (lease expired > ${staleAfter}ms): ${delivery.staleClaims}`,
    );
  if (delivery.ambiguous > 0)
    alerts.push(
      `ambiguous deliveries require operator resolution: ${delivery.ambiguous}`,
    );
  if (rss && rss.orphanDispatches.length > 0)
    alerts.push(`RSS orphan dispatches: ${rss.orphanDispatches.length}`);
  if (rss && rss.tombstones.length > 0)
    alerts.push(`RSS completed tombstones: ${rss.tombstones.length}`);
  if (rss && rss.migrationAnomalies.length > 0)
    alerts.push(
      `RSS migration anomalies (missing dispatch_job_id): ${rss.migrationAnomalies.length} [${rss.migrationAnomalies.map((entry) => entry.dispatchId).join(", ")}]`,
    );
  if (rss)
    for (const error of rss.errors)
      alerts.push(
        `RSS state database unavailable (${error.path}): ${error.error}`,
      );
  return { at: at.toISOString(), queue, delivery, agent, rss, alerts };
}

export function inspectRuntime(
  runtimeDb: Database.Database,
  rssDb?: Database.Database,
  options: { at?: Date; staleAfterMs?: number } = {},
): OperatorInspection {
  const snapshot = collectObservability(runtimeDb, rssDb, options);
  return {
    jobs: z
      .array(
        z.object({
          id: z.string(), status: z.string(), attempts: z.number(),
          max_attempts: z.number(), lease_until: z.string().nullable(),
          worker_id: z.string().nullable(), last_error: z.string().nullable(),
          updated_at: z.string(), result_state: z.string().nullable(),
        }),
      )
      .parse(runtimeDb.prepare(
        "SELECT id,status,attempts,max_attempts,lease_until,worker_id,last_error,updated_at,result_state FROM jobs ORDER BY updated_at DESC",
      ).all()),
    deliveries: z
      .array(
        z.object({
          id: z.string(), job_id: z.string(), status: z.string(), attempts: z.number(),
          lease_until: z.string().nullable(), worker_id: z.string().nullable(),
          last_error: z.string().nullable(), updated_at: z.string(),
        }),
      )
      .parse(runtimeDb.prepare(
        "SELECT id,job_id,status,attempts,lease_until,worker_id,last_error,updated_at FROM deliveries ORDER BY updated_at DESC",
      ).all()),
    deadLetters: z
      .array(
        z.object({
          id: z.string(), job_id: z.string(), reason: z.string(), error: z.string(),
          source: z.string(), created_at: z.string(),
        }),
      )
      .parse(runtimeDb.prepare(
        "SELECT id,job_id,reason,error,source,created_at FROM dead_letters ORDER BY created_at DESC",
      ).all()),
    rss: snapshot.rss,
    alerts: snapshot.alerts,
  };
}

export type StructuredLogField = string | number | boolean | null;
export type StructuredLogFields = Readonly<Record<string, StructuredLogField>>;
export interface StructuredLog {
  at: string;
  component: "queue" | "delivery" | "agent" | "rss";
  event: string;
  fields: StructuredLogFields;
}
export function structuredLog(
  component: StructuredLog["component"],
  event: string,
  fields: StructuredLogFields = {},
  at = new Date(),
): StructuredLog {
  return { at: at.toISOString(), component, event, fields };
}
