import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateModel } from "../agent/model.js";
import type {
  AgentConfig,
  ModelConfig,
  SkillSelection,
} from "../config/groups.js";
import type {
  appendInbox,
  CronDeliveryMode,
  CronSessionMode,
} from "../queue/inbox.js";
import { loadSkills } from "../skills/loader.js";
import { resolveTools } from "../tools/registry.js";
import { NonRetryableError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const GROUPS_DIR = path.join(ROOT, "groups");
const TEMPLATE_SKILLS_DIR = path.join(ROOT, "templates/SKILLS");

export interface CronEnqueueContext {
  id: string;
  groupName?: string;
  channelId?: string;
  deliveryMode?: CronDeliveryMode;
  sessionMode?: CronSessionMode;
  mode?: "to-channel" | "to-thread";
  model?: ModelConfig;
  tools?: string[];
  skills?: SkillSelection;
  idempotencyKey?: string;
  appendInbox: typeof appendInbox;
}

function resolveModes(ctx: CronEnqueueContext): {
  deliveryMode: CronDeliveryMode;
  sessionMode: CronSessionMode;
} {
  if (ctx.deliveryMode && ctx.sessionMode) {
    return {
      deliveryMode: ctx.deliveryMode,
      sessionMode: ctx.sessionMode,
    };
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

export async function enqueueCronInbox(
  ctx: CronEnqueueContext,
  content: string,
): Promise<void> {
  if (!ctx.groupName || !ctx.channelId) {
    throw new NonRetryableError(
      "[cron-enqueue] groupName / channelId が設定されていません",
    );
  }

  await validateConfigOverride(ctx);

  const { deliveryMode, sessionMode } = resolveModes(ctx);
  const sessionId =
    sessionMode === "per-run"
      ? `cron-${ctx.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      : deliveryMode === "direct"
        ? ctx.channelId
        : `cron-${ctx.id}`;
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
    ...(configOverride !== undefined ? { configOverride } : {}),
  });
}
