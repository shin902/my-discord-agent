import { z } from 'zod';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const ChannelConfigSchema = z.object({
  channelId: z.string(),
  sessionMode: z.enum(['shared', 'thread', 'auto-thread']),
});

const GroupConfigSchema = z.object({
  name: z.string(),
  channels: z.array(ChannelConfigSchema),
});

const GroupsConfigSchema = z.array(GroupConfigSchema);

export type ChannelConfig = z.infer<typeof ChannelConfigSchema>;
export type GroupConfig = z.infer<typeof GroupConfigSchema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../../config/groups.json');

export async function loadGroups(): Promise<GroupConfig[]> {
  let text: string;
  try {
    text = await readFile(CONFIG_PATH, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('config/groups.json が見つかりません');
    }
    throw err;
  }
  return GroupsConfigSchema.parse(JSON.parse(text));
}

export async function findGroupByChannelId(
  channelId: string
): Promise<{ group: GroupConfig; channel: ChannelConfig } | null> {
  const groups = await loadGroups();
  for (const group of groups) {
    const channel = group.channels.find((c) => c.channelId === channelId);
    if (channel) return { group, channel };
  }
  return null;
}
