import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Client } from "discord.js";
import { z } from "zod";
import { loadRawCron } from "../config/config.js";
import { AgentConfigSchema } from "../config/groups.js";
import { buildExtraMountArgs } from "../config/mounts.js";
import {
  getDefaultDiscordClient,
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";

import { getQueueRepository } from "../queue/repository.js";
import type { QueueProducer } from "../queue/types.js";

const appendInbox: QueueProducer = async (payload) => {
  await getQueueRepository().enqueue(payload);
};

import { resolveTools } from "../tools/registry.js";
import { NonRetryableError } from "../utils/error.js";
import { enqueueCronInbox } from "./enqueue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const STATE_PATH = path.join(ROOT, "data/cron/state.json");

// --- Schema ---

const CronJobSchema = z
  .object({
    id: z.string(),
    schedule: z.string(),
    enabled: z.boolean().default(true),
    groupName: z.string().min(1).optional(),
    prompt: z.string().optional(),
    channelId: z.string().optional(),
    deliveryMode: z.enum(["direct", "new-thread", "item-thread"]).optional(),
    sessionMode: z.enum(["per-run", "destination"]).optional(),
    noReply: z.boolean().optional(),
    // 後方互換。新規設定では deliveryMode/sessionMode を使用する。
    mode: z.enum(["to-channel", "to-thread"]).optional(),
    handler: z.string().optional(),
    // group/channel と同じ AgentConfig fields。指定時は各フィールドを完全置換する。
    ...AgentConfigSchema.shape,
    // ハンドラー固有の設定値。中身は検証せずそのまま CronContext 経由でハンドラーに渡す
    settings: z.unknown().optional(),
  })
  .superRefine((job, ctx) => {
    const hasLegacyMode = job.mode != null;
    const hasDeliveryMode = job.deliveryMode != null;
    const hasSessionMode = job.sessionMode != null;
    if (hasLegacyMode && (hasDeliveryMode || hasSessionMode)) {
      ctx.addIssue({
        code: "custom",
        message: "mode と deliveryMode/sessionMode は同時に指定できません",
      });
    } else if (hasDeliveryMode !== hasSessionMode) {
      ctx.addIssue({
        code: "custom",
        message: "deliveryMode と sessionMode は両方指定してください",
      });
    }
    if (
      job.deliveryMode === "item-thread" &&
      job.sessionMode !== "destination"
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "item-thread は sessionMode=destination と組み合わせてください",
      });
    }
    if (job.handler != null) return;
    if (job.groupName == null || job.prompt == null || job.channelId == null) {
      ctx.addIssue({
        code: "custom",
        message: "handler なし時は groupName, prompt, channelId が必須です",
      });
    }
    if (!hasLegacyMode && !hasDeliveryMode && !hasSessionMode) {
      ctx.addIssue({
        code: "custom",
        message:
          "handler なし時は deliveryMode, sessionMode が必須です（旧 mode も互換目的で利用可能）",
      });
    }
  });

const CronJobsSchema = z
  .array(CronJobSchema)
  .refine((jobs) => new Set(jobs.map((j) => j.id)).size === jobs.length, {
    message: "ジョブIDが重複しています",
  });

export type CronJob = z.infer<typeof CronJobSchema>;

export type CronContext = {
  client: Client;
  appendInbox: typeof appendInbox;
} & CronJob;

// --- State ---

const CronStateSchema = z.record(z.string(), z.object({ lastRun: z.string() }));
type CronState = z.infer<typeof CronStateSchema>;

let _state: CronState | null = null;

async function loadState(): Promise<CronState> {
  if (_state !== null) return _state;
  if (!existsSync(STATE_PATH)) {
    _state = {};
    return _state;
  }
  _state = CronStateSchema.parse(
    JSON.parse(await readFile(STATE_PATH, "utf-8")),
  );
  return _state;
}

async function saveState(state: CronState): Promise<void> {
  _state = state;
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// --- Schedule matching ---

export function matchField(value: number, field: string): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) return value % parseInt(field.slice(2), 10) === 0;
  if (field.includes(","))
    return field.split(",").some((f) => matchField(value, f.trim()));
  if (field.includes("-")) {
    const [lo, hi] = field.split("-").map(Number);
    return value >= lo && value <= hi;
  }
  return value === parseInt(field, 10);
}

export function cronMatches(expr: string, date: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [min, hour, dom, mon, dow] = parts;
  return (
    matchField(date.getMinutes(), min) &&
    matchField(date.getHours(), hour) &&
    matchField(date.getDate(), dom) &&
    matchField(date.getMonth() + 1, mon) &&
    matchField(date.getDay(), dow)
  );
}

export function parseIntervalMs(schedule: string): number | null {
  const m = schedule.match(/^(\d+)(m|h)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * (m[2] === "h" ? 3_600_000 : 60_000);
}

export function isCronExpr(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5;
}

export function shouldRun(
  schedule: string,
  lastRun: Date | null,
  now: Date,
): boolean {
  if (isCronExpr(schedule)) {
    const floored = new Date(now);
    floored.setSeconds(0, 0);
    // 前回実行時刻 < 今回の予定実行時刻 ≤ 現在時刻
    if (lastRun !== null && floored <= lastRun) return false;
    return cronMatches(schedule, floored);
  }
  const intervalMs = parseIntervalMs(schedule);
  if (intervalMs === null) return false;
  if (lastRun === null) return true;
  return lastRun.getTime() + intervalMs <= now.getTime();
}

// --- Handler loading ---

function resolveHandlerPath(handlerRelPath: string): string {
  if (/\.\.(\/|\\|$)/.test(handlerRelPath)) {
    throw new NonRetryableError(`不正なハンドラーパス: ${handlerRelPath}`);
  }
  // tsx (dev): .ts そのまま / tsc (prod): .ts → .js
  const runnerExt = path.extname(new URL(import.meta.url).pathname);
  const resolvedPath =
    runnerExt === ".ts"
      ? handlerRelPath
      : handlerRelPath.replace(/\.ts$/, ".js");
  const absPath = path.resolve(__dirname, resolvedPath);
  if (!absPath.startsWith(ROOT + path.sep)) {
    throw new NonRetryableError(
      `ハンドラーパスがプロジェクト外を参照しています: ${handlerRelPath}`,
    );
  }
  return absPath;
}

export async function loadHandlerFn(
  handlerRelPath: string,
): Promise<(ctx: CronContext) => Promise<void>> {
  const absPath = resolveHandlerPath(handlerRelPath);
  const mod = (await import(pathToFileURL(absPath).href)) as {
    default?: (ctx: CronContext) => Promise<void>;
  };
  if (typeof mod.default !== "function") {
    throw new NonRetryableError(
      `ハンドラー ${handlerRelPath} に default export (function) がありません`,
    );
  }
  return mod.default;
}

// --- Startup validation ---

async function validateHandlerPath(handlerRelPath: string): Promise<void> {
  await loadHandlerFn(handlerRelPath);
}

/** cron.json を読み込み・スキーマ検証・ハンドラー検証を行う（起動時1回） */
export async function loadAndValidateCron(): Promise<CronJob[]> {
  let raw: unknown;
  try {
    raw = await loadRawCron();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const jobs = CronJobsSchema.parse(raw);
  // enabled な handler 付きジョブのみ起動時に import 検証する（無効化ジョブは対象外）
  const handlers = jobs.filter(
    (j): j is CronJob & { handler: string } =>
      j.enabled && typeof j.handler === "string",
  );
  await Promise.all(handlers.map((h) => validateHandlerPath(h.handler)));
  for (const job of jobs) {
    if (job.enabled && !job.handler) {
      if (job.tools !== undefined) resolveTools(job.tools);
      if (job.mounts !== undefined) buildExtraMountArgs(job.mounts);
    }
  }
  return jobs;
}

// --- Job execution ---

export async function executeJob(job: CronJob): Promise<void> {
  const discordClient = job.groupName
    ? await getDiscordClientForGroupName(job.groupName)
    : getDefaultDiscordClient();
  const ctx: CronContext = { client: discordClient, appendInbox, ...job };

  if (job.handler) {
    const fn = await loadHandlerFn(job.handler);
    await fn(ctx);
    return;
  }

  if (job.prompt === undefined) {
    throw new NonRetryableError("[cron-enqueue] prompt が設定されていません");
  }
  await enqueueCronInbox(ctx, job.prompt);
}

// --- Scheduler ---

let _jobs: CronJob[] = [];

export function _setCronJobs(jobs: CronJob[]): void {
  _jobs = jobs;
}

async function tick(): Promise<void> {
  if (_isRunning) return;
  if (![...getDiscordClients().values()].some((value) => value.isReady()))
    return;
  _isRunning = true;
  try {
    if (_jobs.length === 0) return;

    const now = new Date();
    const state = await loadState();
    const toRun: CronJob[] = [];

    for (const job of _jobs) {
      if (!job.enabled) continue;
      const entry = state[job.id];
      const lastRun = entry ? new Date(entry.lastRun) : null;
      if (shouldRun(job.schedule, lastRun, now)) {
        toRun.push(job);
      }
    }

    if (toRun.length === 0) return;

    for (const job of toRun) {
      console.log(`[cron] "${job.id}" 開始`);
    }

    const results = await Promise.allSettled(
      toRun.map((job) => executeJob(job)),
    );

    let changed = false;
    for (let i = 0; i < toRun.length; i++) {
      const result = results[i];
      const job = toRun[i];
      if (result.status === "fulfilled") {
        console.log(`[cron] "${job.id}" 完了`);
        state[job.id] = { lastRun: now.toISOString() };
        changed = true;
      } else if (result.reason instanceof NonRetryableError) {
        // 設定ミスなど永続的なエラーは lastRun を更新してリトライを止める
        console.error(`[cron] "${job.id}" 非リトライエラー:`, result.reason);
        state[job.id] = { lastRun: now.toISOString() };
        changed = true;
      } else {
        // 一時的なエラーは lastRun を更新せず次の tick でリトライ
        console.error(
          `[cron] "${job.id}" 実行エラー（次のtickでリトライ）:`,
          result.reason,
        );
      }
    }

    if (changed) await saveState(state);
  } finally {
    _isRunning = false;
  }
}

let _isRunning = false;
let _timer: NodeJS.Timeout | null = null;
let _alignTimeout: NodeJS.Timeout | null = null;

export function startCron(): void {
  if (_timer !== null || _alignTimeout !== null) return;
  const msToNextMinute = (60_000 - (Date.now() % 60_000)) % 60_000;
  _alignTimeout = setTimeout(() => {
    _alignTimeout = null;
    tick().catch((err) => console.error("[cron] tick エラー:", err));
    _timer = setInterval(() => {
      tick().catch((err) => console.error("[cron] tick エラー:", err));
    }, 60_000);
  }, msToNextMinute);
}

export function stopCron(): void {
  if (_alignTimeout !== null) {
    clearTimeout(_alignTimeout);
    _alignTimeout = null;
  }
  if (_timer !== null) {
    clearInterval(_timer);
    _timer = null;
  }
}