import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  type AgentMemorySettings,
  AgentMemorySettingsSchema,
} from "../features/agent-memory/config.js";
import { loadRawGroups } from "./config.js";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly [ModelThinkingLevel, ...ModelThinkingLevel[]];

export const ModelConfigSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
});

// skills 未指定または [] は「スキルなし」。明示したスキルだけを読み込む。
export const SkillSelectionSchema = z.array(z.string());

export const MountConfigSchema = z.object({
  host: z.string(),
  container: z.string().startsWith("/", {
    message: "mounts.container は絶対パスで指定してください",
  }),
  readOnly: z.boolean().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type SkillSelection = z.infer<typeof SkillSelectionSchema>;
export type MountConfig = z.infer<typeof MountConfigSchema>;

export const ContextFileConfigSchema = z.object({
  path: z
    .string()
    .min(1)
    .refine(
      (value) =>
        !value.startsWith("/") &&
        value.split("/").every((segment) => segment !== ".."),
      "contextFiles.path はworkspace相対パスで指定してください",
    ),
  maxChars: z.union([z.number().int().positive(), z.literal("*")]),
});

export type ContextFileConfig = z.infer<typeof ContextFileConfigSchema>;

/** Effective agent configuration after all trusted layers are resolved. */
export interface AgentConfig {
  agentMemory?: AgentMemorySettings;
  model?: ModelConfig;
  tools: string[];
  toolSets?: string[];
  approvalRequiredTools?: string[];
  skills?: SkillSelection;
  mounts?: MountConfig[];
  contextFiles?: ContextFileConfig[];
}

// 各信頼済み設定階層で指定できる共通override設定（agentMemoryは含めない）。
// オブジェクト・配列を含め、階層解決時はフィールド単位で完全置換する。
// tools は継承元で指定できるため、各入力階層では optional のままにする。
export const AgentConfigSchema = z.object({
  model: ModelConfigSchema.optional(),
  tools: z.array(z.string()).optional(),
  toolSets: z.array(z.string()).optional(),
  approvalRequiredTools: z.array(z.string()).optional(),
  skills: SkillSelectionSchema.optional(),
  mounts: z.array(MountConfigSchema).optional(),
  contextFiles: z.array(ContextFileConfigSchema).optional(),
});

// sandboxへ渡す実行設定。group限定のtoolLogArgsはagentのイベント整形に必要だが、
// channel/cronの共通override対象には含めない。
export const AgentRuntimeConfigSchema = AgentConfigSchema.extend({
  agentMemory: AgentMemorySettingsSchema.optional(),
  allowMention: z.boolean().optional(),
  toolLogArgs: z.boolean().optional(),
});

// チャンネル固有のrouting設定と共通override。agentMemoryはGroup/Bot限定。
const ChannelConfigSchema = AgentConfigSchema.extend({
  channelId: z.string(),
  botId: z.string().min(1).optional(),
  sessionMode: z.enum(["shared", "thread", "auto-thread", "email-mode"]),
  sessionContext: z.literal("final-only").optional(),
  appendUserOnly: z.boolean().optional(),
  // true の場合、親チャンネルとその配下スレッドの通常メッセージはBotへのmention時だけ処理する。
  requiredMention: z.boolean().optional(),
  // feedcord 等、Webhook経由でこのチャンネルに投稿するメッセージを許可するWebhook IDのリスト
  allowedWebhookIds: z.array(z.string()).optional(),
}).refine(
  (channel) => !channel.appendUserOnly || channel.sessionMode === "shared",
  {
    message: "appendUserOnly requires sessionMode: shared",
    path: ["appendUserOnly"],
  },
);

// allowMention/toolLogArgs は配送・観測設定であり、group限定のままにする。
const GroupConfigSchema = AgentRuntimeConfigSchema.extend({
  // Fail early instead of silently stripping a misplaced channel-only setting.
  sessionContext: z.never().optional(),
  name: z.string(),
  bot: z.string().min(1).optional(),
  channels: z.array(ChannelConfigSchema),
});

const GroupsConfigSchema = z.array(GroupConfigSchema);

function parseGroups(raw: unknown): GroupConfig[] {
  return GroupsConfigSchema.parse(raw);
}

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
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
