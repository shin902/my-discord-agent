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
  mode?: "to-channel" | "to-thread";
  model?: ModelConfig;
  tools?: string[];
  skills?: SkillSelection;
  idempotencyKey?: string;
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
  /** Stable source identity supplied by the handler. */
  idempotencyKey: string;
  sourceType?: string;
  sourceId?: string;
  threadName?: string;
}

type CronItemThreadRegistrationOptions = Pick<
  CronItemThreadOptions,
  "idempotencyKey" | "sourceType" | "sourceId"
>;

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
  messages?: { fetch: (id: string) => Promise<ItemThreadMessage> };
};

type ItemThreadChannelLookup = {
  id: string;
  parentId?: string | null;
};

function isDefinitiveMissingDiscordResource(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const code = Number(value.code);
  const status = Number(value.status);
  const statusCode = Number(value.statusCode);
  return (
    code === 10003 || code === 10008 || status === 404 || statusCode === 404
  );
}

async function fetchExistingItemThread(
  client: Client,
  parentChannelId: string,
  starterMessageId: string,
): Promise<ItemThreadChannelLookup | undefined> {
  try {
    const thread = (await client.channels.fetch(starterMessageId, {
      force: true,
    })) as unknown as ItemThreadChannelLookup | null;
    if (!thread) return undefined;
    if (thread.parentId !== undefined && thread.parentId !== parentChannelId) {
      throw new Error(
        `既存スレッド ${starterMessageId} の親チャンネルが一致しません`,
      );
    }
    if (thread.id !== starterMessageId) {
      throw new Error(`既存スレッド ${starterMessageId} の識別情報が不正です`);
    }
    return thread;
  } catch (error) {
    if (isDefinitiveMissingDiscordResource(error)) return undefined;
    throw error;
  }
}

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

  const placeholder = job.cronPlaceholderMessageId
    ? await channel.messages?.fetch(job.cronPlaceholderMessageId)
    : await channel.send("処理中…");
  if (!placeholder) {
    throw new Error("[cron-item-thread] placeholder message unavailable");
  }
  const placeholderId = String(placeholder.id);
  if (!job.cronPlaceholderMessageId) {
    repository.patchJobPayload(job.id, {
      cronPlaceholderMessageId: placeholderId,
    });
  }

  const existingThread = await fetchExistingItemThread(
    client,
    job.channelId,
    placeholderId,
  );
  const thread =
    existingThread ??
    (await placeholder.startThread({
      name: (options.threadName ?? `cron-${job.cronJobId ?? job.id}`).slice(
        0,
        100,
      ),
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    }));
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

function hasMatchingItemSource(
  job: QueueJob,
  options: CronItemThreadRegistrationOptions,
): boolean {
  return (
    job.cronSourceType === options.sourceType &&
    job.cronSourceId === options.sourceId
  );
}

function isLegacyMailItem(
  job: QueueJob,
  options: CronItemThreadRegistrationOptions,
): boolean {
  return (
    job.cronDeliveryMode === "new-thread" &&
    job.cronThread === true &&
    options.sourceType === "mail" &&
    options.sourceId !== undefined &&
    job.cronSourceType === "mail" &&
    job.cronSourceId === options.sourceId
  );
}

async function registerCronItemThread(
  ctx: CronEnqueueContext,
  content: string,
  options: CronItemThreadRegistrationOptions,
): Promise<QueueJob | undefined> {
  if (!ctx.groupName || !ctx.channelId) {
    throw new NonRetryableError(
      "[cron-item-thread] groupName / channelId が設定されていません",
    );
  }
  if (!options.idempotencyKey) {
    throw new NonRetryableError(
      "[cron-item-thread] handler は安定した idempotencyKey を指定してください",
    );
  }
  await validateConfigOverride(ctx);

  const key = options.idempotencyKey;
  const repository = getQueueRepository();
  let job = repository.findByIdempotencyKey(key);
  if (!job) {
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
      cronThread: true,
      cronJobId: ctx.id,
      cronProvisioning: true,
      idempotencyKey: key,
      ...(options.sourceType ? { cronSourceType: options.sourceType } : {}),
      ...(options.sourceId ? { cronSourceId: options.sourceId } : {}),
      ...(configOverride !== undefined ? { configOverride } : {}),
    });
    job = repository.findByIdempotencyKey(key);
  }
  if (!job) return undefined;
  const terminal = job.status === "completed" || job.status === "dead_letter";

  if (job.cronDeliveryMode === "item-thread") {
    if (!hasMatchingItemSource(job, options)) {
      throw new NonRetryableError(
        `[cron-item-thread] idempotencyKey ${key} は別のitem-thread項目に使用されています`,
      );
    }
    return terminal ? undefined : job;
  }

  if (!isLegacyMailItem(job, options)) {
    throw new NonRetryableError(
      `[cron-item-thread] idempotencyKey ${key} は既存の別cronジョブに使用されています`,
    );
  }
  if (terminal) return undefined;
  return (
    repository.patchJobPayload(job.id, {
      cronDeliveryMode: "item-thread",
      cronSessionMode: "destination",
      cronThread: true,
    }) ?? job
  );
}

/** Register one handler item and provision its Discord thread before returning. */
export async function enqueueCronItemThread(
  ctx: CronEnqueueContext,
  content: string,
  options: CronItemThreadOptions,
): Promise<void> {
  const job = await registerCronItemThread(ctx, content, options);
  if (!job) return;

  const repository = getQueueRepository();
  if (
    job.cronThreadId &&
    job.cronPlaceholderMessageId &&
    job.cronProvisioning !== true &&
    job.sessionId === job.cronThreadId
  )
    return;
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
    await registerCronItemThread(ctx, content, {
      idempotencyKey:
        ctx.idempotencyKey ?? `cron-item:${ctx.id}:${randomUUID()}`,
    });
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
    cronJobId: ctx.id,
    ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
    ...(ctx.rssDispatchId ? { rssDispatchId: ctx.rssDispatchId } : {}),
    ...(ctx.rssStatePath ? { rssStatePath: ctx.rssStatePath } : {}),
    ...(configOverride !== undefined ? { configOverride } : {}),
  });
}
