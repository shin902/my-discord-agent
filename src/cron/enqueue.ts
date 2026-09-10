import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "discord.js";
import { validateModel } from "../agent/model.js";
import { pickAgentConfig } from "../config/agent-resolution.js";
import type { AgentConfig, SkillSelection } from "../config/groups.js";
import { buildExtraMountArgs } from "../config/mounts.js";
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

export type CronEnqueueContext = {
  id: string;
  client: Client;
  groupName?: string;
  channelId?: string;
  deliveryMode?: CronDeliveryMode;
  sessionMode?: CronSessionMode;
  noReply?: boolean;
  mode?: "to-channel" | "to-thread";
  idempotencyKey?: string;
  mailEmailId?: string;
  rssDispatchId?: string;
  rssStatePath?: string;
  appendInbox: QueueProducer;
} & Partial<AgentConfig>;

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
  const override = pickAgentConfig(ctx);
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
    if (ctx.mounts !== undefined) buildExtraMountArgs(ctx.mounts);
    if (ctx.skills !== undefined && ctx.groupName !== undefined) {
      await validateSkills(ctx.groupName, ctx.skills);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NonRetryableError(
      `[cron-enqueue] AgentConfig (model/tools/skills/mounts) の設定が不正です: ${message}`,
    );
  }
}

async function registerCronItemThread(
  ctx: CronEnqueueContext,
  content: string,
): Promise<void> {
  if (!ctx.groupName || !ctx.channelId) {
    throw new NonRetryableError(
      "[cron-item-thread] groupName / channelId が設定されていません",
    );
  }
  await validateConfigOverride(ctx);

  // RSS dispatches already own a durable idempotency key. Keep it as the
  // queue identity; the temporary sessionId below is a separate identity used
  // only until Discord delivery materializes the destination thread.
  const key = ctx.idempotencyKey ?? `cron-item:${ctx.id}:${randomUUID()}`;
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
    ...(ctx.rssDispatchId ? { rssDispatchId: ctx.rssDispatchId } : {}),
    ...(ctx.rssStatePath ? { rssStatePath: ctx.rssStatePath } : {}),
    ...(configOverride !== undefined ? { configOverride } : {}),
  });
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
