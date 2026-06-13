import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import { loadRawConfig } from "./config.js";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly [ModelThinkingLevel, ...ModelThinkingLevel[]];

export const ModelConfigSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

const ChannelConfigSchema = z.object({
  channelId: z.string(),
  sessionMode: z.enum(["shared", "thread", "auto-thread", "email-mode"]),
  // feedcord 等、Webhook経由でこのチャンネルに投稿するメッセージを許可するWebhook IDのリスト
  allowedWebhookIds: z.array(z.string()).optional(),
});

const MountConfigSchema = z.object({
  host: z.string(),
  container: z.string().startsWith("/", {
    message: "mounts.container は絶対パスで指定してください",
  }),
  readOnly: z.boolean().optional(),
});

// エージェントの挙動を決める設定。サンドボックスコンテナにそのまま渡される
// （エージェント自身が書き換えられない config/config.json 側で管理する）
export const AgentConfigSchema = z.object({
  model: ModelConfigSchema.optional(),
  tools: z.array(z.string()).optional(),
  autoReply: z.boolean().optional(),
  toolLogArgs: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
});

const GroupConfigSchema = AgentConfigSchema.extend({
  name: z.string(),
  channels: z.array(ChannelConfigSchema),
  mounts: z.array(MountConfigSchema).optional(),
});

const GroupsConfigSchema = z.array(GroupConfigSchema);

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type MountConfig = z.infer<typeof MountConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type GroupConfig = z.infer<typeof GroupConfigSchema>;

let _groups: GroupConfig[] | null = null;

export async function loadGroups(): Promise<GroupConfig[]> {
  if (_groups !== null) return _groups;
  const raw = await loadRawConfig();
  if (raw.groups === undefined) {
    throw new Error(
      "config/config.json に groups キーがありません（groups は必須項目です）",
    );
  }
  _groups = GroupsConfigSchema.parse(raw.groups);
  return _groups;
}

export async function findGroupByName(
  name: string,
): Promise<GroupConfig | undefined> {
  const groups = await loadGroups();
  return groups.find((g) => g.name === name);
}

export async function findGroupByChannelId(
  channelId: string,
): Promise<{ group: GroupConfig; channel: ChannelConfig } | null> {
  const groups = await loadGroups();
  for (const group of groups) {
    const channel = group.channels.find((c) => c.channelId === channelId);
    if (channel) return { group, channel };
  }
  return null;
}
