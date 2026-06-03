import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { TextChannel } from "discord.js";
import { z } from "zod";
import { client } from "../discord/client.js";
import { appendInbox } from "../queue/inbox.js";
import { NonRetryableError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");
const CRON_JOBS_PATH = path.join(ROOT, "config/cron-jobs.json");
const STATE_PATH = path.join(ROOT, "data/cron/state.json");

// --- Schema ---

const CronJobSchema = z
  .object({
    id: z.string(),
    schedule: z.string(),
    groupName: z.string().optional(),
    prompt: z.string().optional(),
    channelId: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    allowedSkills: z.array(z.string()).optional(),
    mode: z.enum(["channel", "thread"]).optional(),
    handler: z.string().optional(),
  })
  .refine(
    (job) =>
      job.handler != null ||
      (job.groupName != null &&
        job.prompt != null &&
        job.channelId != null &&
        job.mode != null),
    {
      message: "handler なし時は groupName, prompt, channelId, mode が必須です",
    },
  );

const CronJobsSchema = z.array(CronJobSchema);

export type CronJob = z.infer<typeof CronJobSchema>;

export type CronContext = {
  client: typeof client;
  appendInbox: typeof appendInbox;
} & CronJob;

// --- State ---

type CronState = Record<string, { lastRun: string }>;

async function loadState(): Promise<CronState> {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(await readFile(STATE_PATH, "utf-8")) as CronState;
}

async function saveState(state: CronState): Promise<void> {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

// --- Schedule matching ---

function matchField(value: number, field: string): boolean {
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

function cronMatches(expr: string, date: Date): boolean {
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

function parseIntervalMs(schedule: string): number | null {
  const m = schedule.match(/^(\d+)(m|h)$/);
  if (!m) return null;
  return parseInt(m[1], 10) * (m[2] === "h" ? 3_600_000 : 60_000);
}

function isCronExpr(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5;
}

function shouldRun(schedule: string, lastRun: Date | null, now: Date): boolean {
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

async function loadHandlerFn(
  handlerRelPath: string,
): Promise<(ctx: CronContext) => Promise<void>> {
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
  if (!absPath.startsWith(ROOT)) {
    throw new NonRetryableError(
      `ハンドラーパスがプロジェクト外を参照しています: ${handlerRelPath}`,
    );
  }
  const absUrl = pathToFileURL(absPath).href;
  const mod = (await import(absUrl)) as {
    default?: (ctx: CronContext) => Promise<void>;
  };
  if (typeof mod.default !== "function") {
    throw new NonRetryableError(
      `ハンドラー ${handlerRelPath} に default export がありません`,
    );
  }
  return mod.default;
}

// --- Job execution ---

async function executeJob(job: CronJob): Promise<void> {
  const ctx: CronContext = { client, appendInbox, ...job };

  if (job.handler) {
    const fn = await loadHandlerFn(job.handler);
    await fn(ctx);
    return;
  }

  // handler なし: groupName, prompt, channelId, mode は Zod refine で保証済み
  const { groupName, prompt, channelId, mode } = job;
  if (!groupName || !prompt || !channelId || !mode) {
    throw new Error(`[cron] "${job.id}": 必須フィールドが未設定です`);
  }
  const timestamp = new Date().toISOString();

  if (mode === "channel") {
    // 毎回独立したセッション
    await appendInbox({
      channelId,
      groupName,
      sessionId: `cron-${job.id}-${Date.now()}`,
      content: prompt,
      timestamp,
    });
  } else {
    // mode === "thread": 実行のたびに新しいスレッドを作成
    const channel = await client.channels.fetch(channelId);
    if (!channel || !("threads" in channel)) {
      throw new Error(
        `チャンネル ${channelId} はスレッドをサポートしていません`,
      );
    }
    const thread = await (channel as TextChannel).threads.create({
      name: `cron-${job.id}`,
    });
    await appendInbox({
      channelId: thread.id,
      groupName,
      sessionId: thread.id,
      content: prompt,
      timestamp,
    });
  }
}

// --- Scheduler ---

let _jobs: CronJob[] | null = null;

async function loadJobs(): Promise<CronJob[]> {
  if (_jobs !== null) return _jobs;
  if (!existsSync(CRON_JOBS_PATH)) {
    _jobs = [];
    return _jobs;
  }
  const text = await readFile(CRON_JOBS_PATH, "utf-8");
  _jobs = CronJobsSchema.parse(JSON.parse(text));
  return _jobs;
}

async function tick(): Promise<void> {
  if (!client.isReady()) return;

  const jobs = await loadJobs();
  if (jobs.length === 0) return;

  const now = new Date();
  const state = await loadState();
  const toRun: CronJob[] = [];

  for (const job of jobs) {
    const entry = state[job.id];
    const lastRun = entry ? new Date(entry.lastRun) : null;
    if (shouldRun(job.schedule, lastRun, now)) {
      toRun.push(job);
    }
  }

  if (toRun.length === 0) return;

  const results = await Promise.allSettled(toRun.map((job) => executeJob(job)));

  let changed = false;
  for (let i = 0; i < toRun.length; i++) {
    const result = results[i];
    const job = toRun[i];
    if (result.status === "fulfilled") {
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
}

let _timer: NodeJS.Timeout | null = null;
let _alignTimeout: NodeJS.Timeout | null = null;

export function startCron(): void {
  if (_timer !== null || _alignTimeout !== null) return;
  const msToNextMinute = (60_000 - Date.now() % 60_000) % 60_000;
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
