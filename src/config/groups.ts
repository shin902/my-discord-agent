import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const ChannelConfigSchema = z.object({
  channelId: z.string(),
  sessionMode: z.enum(["shared", "thread", "auto-thread", "email-mode"]),
});

const GroupConfigSchema = z.object({
  name: z.string(),
  channels: z.array(ChannelConfigSchema),
});

const GroupsConfigSchema = z.array(GroupConfigSchema);

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type GroupConfig = z.infer<typeof GroupConfigSchema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "../../config/groups.json");

let _groups: GroupConfig[] | null = null;

export async function loadGroups(): Promise<GroupConfig[]> {
  if (_groups !== null) return _groups;
  let text: string;
  try {
    text = await readFile(CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("config/groups.json が見つかりません");
    }
    throw err;
  }
  _groups = GroupsConfigSchema.parse(JSON.parse(text));
  return _groups;
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
