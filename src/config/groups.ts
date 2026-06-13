import { z } from "zod";
import { loadRawConfig } from "./config.js";

const ChannelConfigSchema = z.object({
  channelId: z.string(),
  sessionMode: z.enum(["shared", "thread", "auto-thread", "email-mode"]),
});

const MountConfigSchema = z.object({
  host: z.string(),
  container: z.string().startsWith("/", {
    message: "mounts.container は絶対パスで指定してください",
  }),
  readOnly: z.boolean().optional(),
});

const GroupConfigSchema = z.object({
  name: z.string(),
  channels: z.array(ChannelConfigSchema),
  mounts: z.array(MountConfigSchema).optional(),
});

const GroupsConfigSchema = z.array(GroupConfigSchema);

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type MountConfig = z.infer<typeof MountConfigSchema>;
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
