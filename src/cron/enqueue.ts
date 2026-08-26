import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChannelType,
  type Client,
  ThreadAutoArchiveDuration,
} from "discord.js";
import { validateModel } from "../agent/model.js";
import type {
  AgentConfig,
  ModelConfig,
  SkillSelection,
} from "../config/groups.js";
import {
  getQueueRepository,
  type QueueJob,
  type QueueRepository,
} from "../queue/repository.js";
import type {
  CronDeliveryMode,
  CronSessionMode,
  QueueProducer,
} from "../queue/types.js";
import { loadSkills } from "../skills/loader.js";
import { resolveTools } from "../tools/registry.js";
import { NonRetryableError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const GROUPS_DIR = path.join(ROOT, "groups");
const TEMPLATE_SKILLS_DIR = path.join(ROOT, "templates/SKILLS");

export interface CronEnqueueContext {
  id: string;
  client: Client;
  groupName?: string;
  channelId?: string;
  deliveryMode?: CronDeliveryMode;
  sessionMode?: CronSessionMode;
  noReply?: boolean;
  mode?: "to-channel" | "to-thread";
  model?: ModelConfig;
  tools?: string[];
  skills?: SkillSelection;
  idempotencyKey?: string;
  mailEmailId?: string;
  rssDispatchId?: string;
  rssStatePath?: string;
  appendInbox: QueueProducer;
}

function resolveModes(ctx: CronEnqueueContext): {
  deliveryMode: CronDeliveryMode;
  sessionMode: CronSessionMode;
} {
  if (ctx.deliveryMode && ctx.sessionMode) {
    if (
      ctx.deliveryMode === "item-thread" &&
      ctx.sessionMode !== "destination"
    ) {
      throw new NonRetryableError(
        "[cron-enqueue] item-thread は sessionMode=destination と組み合わせてください",
      );
    }
    return {
      deliveryMode: ctx.deliveryMode,
      sessionMode: ctx.sessionMode,
    };
  }
  if (ctx.deliveryMode === "item-thread") {
    throw new NonRetryableError(
      "[cron-enqueue] item-thread は sessionMode=destination と組み合わせてください",
    );
  }
  if (ctx.mode === "to-thread") {
    return { deliveryMode: "new-thread", sessionMode: "destination" };
  }
  return { deliveryMode: "direct", sessionMode: "per-run" };
}

function buildConfigOverride(
  ctx: CronEnqueueContext,
): Partial<AgentConfig> | undefined {
  const override: Partial<AgentConfig> = {};
  if (ctx.model !== undefined) override.model = ctx.model;
  if (ctx.tools !== undefined) override.tools = ctx.tools;
  if (ctx.skills !== undefined) override.skills = ctx.skills;
  return Object.keys(override).length > 0 ? override : undefined;
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function validateSkills(
  groupName: string,
  selection: SkillSelection,
): Promise<void> {
  if (!Array.isArray(selection)) return;
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName)) {
    throw new Error(`不正なグループ名: ${groupName}`);
  }

  const groupSkillsDir = path.join(GROUPS_DIR, groupName, "SKILLS");
  for (const skill of selection) {
    if (!/^[a-zA-Z0-9_-]+$/.test(skill)) {
      throw new Error(`不正なスキル名: ${skill}`);
    }
    const skillsDir = (await isDirectory(path.join(groupSkillsDir, skill)))
      ? groupSkillsDir
      : TEMPLATE_SKILLS_DIR;
    await loadSkills(skillsDir, [skill]);
  }
}

async function validateConfigOverride(ctx: CronEnqueueContext): Promise<void> {
  try {
    if (ctx.model !== undefined) {
      await validateModel(ctx.model.provider, ctx.model.modelId);
    }
    if (ctx.tools !== undefined) resolveTools(ctx.tools);
    if (ctx.skills !== undefined && ctx.groupName !== undefined) {
      await validateSkills(ctx.groupName, ctx.skills);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NonRetryableError(
      `[cron-enqueue] model/tools/skills の設定が不正です: ${message}`,
    );
  }
}

export interface CronItemThreadOptions {
  threadName?: string;
}

type ItemThreadMessage = {
  id: unknown;
  startThread: (options: {
    name: string;
    autoArchiveDuration: ThreadAutoArchiveDuration;
  }) => Promise<{ id?: unknown }>;
};

type ItemThreadChannel = {
  type?: number;
  send: (content: unknown) => Promise<ItemThreadMessage>;
};

/**
 * Reserve the Discord destination for one cron item and make its thread the
 * durable queue session. Handlers use this for multi-item sources; declarative
 * item-thread jobs let the poller perform the same step before AI execution.
 */
export async function provisionCronItemThread(
  client: Client,
  repository: QueueRepository,
  job: QueueJob,
  options: Pick<CronItemThreadOptions, "threadName"> = {},
): Promise<QueueJob> {
  const channel = (await client.channels.fetch(
    job.channelId,
  )) as unknown as ItemThreadChannel | null;
  if (
    !channel ||
    (channel.type !== undefined &&
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    throw new NonRetryableError(
      `[cron-item-thread] チャンネル ${job.channelId} はスレッドをサポートしていません`,
    );
  }

  const placeholder = await channel.send("処理中…");
  const placeholderId = String(placeholder.id);
  const thread = await placeholder.startThread({
    name: (options.threadName ?? `cron-${job.cronJobId ?? job.id}`).slice(
      0,
      100,
    ),
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
  });
  const threadId = String(thread.id ?? "");
  if (!threadId) {
    throw new NonRetryableError(
      "[cron-item-thread] Discord thread ID が空です",
    );
  }

  const provisioned = repository.provisionCronJob(job.id, threadId, {
    cronDeliveryMode: "item-thread",
    cronSessionMode: "destination",
    cronThread: true,
    cronThreadId: threadId,
    cronPlaceholderMessageId: placeholderId,
  });
  if (!provisioned) {
    throw new Error(`[cron-item-thread] job ${job.id} が見つかりません`);
  }
  return provisioned;
}

async function registerCronItemThread(
  ctx: CronEnqueueContext,
  content: string,
): Promise<QueueJob | undefined> {
  if (!ctx.groupName || !ctx.channelId) {
    throw new NonRetryableError(
      "[cron-item-thread] groupName / channelId が設定されていません",
    );
  }
  await validateConfigOverride(ctx);

  const key = `cron-item:${ctx.id}:${randomUUID()}`;
  const repository = getQueueRepository();
  const configOverride = buildConfigOverride(ctx);
  const sessionId = `cron-${ctx.id}-${randomUUID()}`;
  await ctx.appendInbox({
    channelId: ctx.channelId,
    groupName: ctx.groupName,
    sessionId,
    content,
    timestamp: new Date().toISOString(),
    cronDeliveryMode: "item-thread",
    cronSessionMode: "destination",
    ...(ctx.noReply ? { cronNoReply: true } : {}),
    cronThread: true,
    cronJobId: ctx.id,
    cronProvisioning: true,
    idempotencyKey: key,
    ...(ctx.mailEmailId ? { mailEmailId: ctx.mailEmailId } : {}),
    ...(configOverride !== undefined ? { configOverride } : {}),
  });
  return repository.findByIdempotencyKey(key);
}

/**
 * Register one handler item and provision its Discord thread before returning.
 *
 * @deprecated Handler-side provisioning is retained for compatibility. Callers
 * are responsible for coordinating it with poller provisioning; declarative
 * item-thread jobs should be preferred when possible.
 */
export async function enqueueCronItemThread(
  ctx: CronEnqueueContext,
  content: string,
  options: CronItemThreadOptions = {},
): Promise<void> {
  const job = await registerCronItemThread(ctx, content);
  if (!job) return;

  const repository = getQueueRepository();
  await provisionCronItemThread(ctx.client, repository, job, options);
}

export async function enqueueCronInbox(
  ctx: CronEnqueueContext,
  content: string,
): Promise<void> {
  if (!ctx.groupName || !ctx.channelId) {
    throw new NonRetryableError(
      "[cron-enqueue] groupName / channelId が設定されていません",
    );
  }

  const { deliveryMode, sessionMode } = resolveModes(ctx);
  if (deliveryMode === "item-thread") {
    await registerCronItemThread(ctx, content);
    return;
  }

  await validateConfigOverride(ctx);

  const sessionId =
    sessionMode === "per-run" || deliveryMode === "new-thread"
      ? `cron-${ctx.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : ctx.channelId;
  const configOverride = buildConfigOverride(ctx);

  await ctx.appendInbox({
    channelId: ctx.channelId,
    groupName: ctx.groupName,
    sessionId,
    content,
    timestamp: new Date().toISOString(),
    cronDeliveryMode: deliveryMode,
    cronSessionMode: sessionMode,
    ...(ctx.noReply ? { cronNoReply: true } : {}),
    cronJobId: ctx.id,
    ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
    ...(ctx.mailEmailId ? { mailEmailId: ctx.mailEmailId } : {}),
    ...(ctx.rssDispatchId ? { rssDispatchId: ctx.rssDispatchId } : {}),
    ...(ctx.rssStatePath ? { rssStatePath: ctx.rssStatePath } : {}),
    ...(configOverride !== undefined ? { configOverride } : {}),
  });
}
