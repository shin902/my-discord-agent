import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import { loadRawGroups } from "./config.js";

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

// skills 未指定は「スキルなし」。全スキルを読み込む場合は "*" を明示する。
export const SkillSelectionSchema = z.union([
  z.array(z.string()),
  z.literal("*"),
]);

export const MountConfigSchema = z.object({
  host: z.string(),
  container: z.string().startsWith("/", {
    message: "mounts.container は絶対パスで指定してください",
  }),
  readOnly: z.boolean().optional(),
});

// 各信頼済み設定階層で指定できるエージェント実行設定。
// オブジェクト・配列を含め、階層解決時はフィールド単位で完全置換する。
export const AgentConfigSchema = z.object({
  model: ModelConfigSchema.optional(),
  tools: z.array(z.string()).optional(),
  skills: SkillSelectionSchema.optional(),
  mounts: z.array(MountConfigSchema).optional(),
});

// sandboxへ渡す実行設定。group限定のtoolLogArgsはagentのイベント整形に必要だが、
// channel/cronの共通override対象には含めない。
export const AgentRuntimeConfigSchema = AgentConfigSchema.extend({
  allowMention: z.boolean().optional(),
  toolLogArgs: z.boolean().optional(),
});

// チャンネル固有のrouting設定に加えて、AgentConfigを任意で上書きできる。
const ChannelConfigSchema = AgentConfigSchema.extend({
  channelId: z.string(),
  sessionMode: z.enum(["shared", "thread", "auto-thread", "email-mode"]),
  // true の場合、親チャンネルとその配下スレッドの通常メッセージはBotへのmention時だけ処理する。
  requiredMention: z.boolean().optional(),
  // feedcord 等、Webhook経由でこのチャンネルに投稿するメッセージを許可するWebhook IDのリスト
  allowedWebhookIds: z.array(z.string()).optional(),
});

// allowMention/toolLogArgs は配送・観測設定であり、group限定のままにする。
const GroupConfigSchema = AgentRuntimeConfigSchema.extend({
  name: z.string(),
  bot: z.string().min(1).optional(),
  // Host mutations fail closed unless an explicit Discord approver is configured.
  approvalUserIds: z.array(z.string().min(1)).optional(),
  channels: z.array(ChannelConfigSchema),
});

const GroupsConfigSchema = z.array(GroupConfigSchema);

function parseGroups(raw: unknown): GroupConfig[] {
  return GroupsConfigSchema.parse(raw);
}

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type SkillSelection = z.infer<typeof SkillSelectionSchema>;
export type MountConfig = z.infer<typeof MountConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export type AgentRuntimeConfig = z.infer<typeof AgentRuntimeConfigSchema>;
export type GroupConfig = z.infer<typeof GroupConfigSchema>;

let _groups: GroupConfig[] | null = null;

export async function loadGroups(): Promise<GroupConfig[]> {
  if (_groups !== null) return _groups;
  const raw = await loadRawGroups();
  _groups = parseGroups(raw);
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
  return findGroupByChannelIdIn(groups, channelId);
}

function findGroupByChannelIdIn(
  groups: GroupConfig[],
  channelId: string,
): { group: GroupConfig; channel: ChannelConfig } | null {
  for (const group of groups) {
    const channel = group.channels.find((c) => c.channelId === channelId);
    if (channel) return { group, channel };
  }
  return null;
}
