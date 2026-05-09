import { z } from 'zod';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ModelConfigSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
});

const GroupJsonSchema = z.object({
  model: ModelConfigSchema.optional(),
});

export type GroupJsonConfig = z.infer<typeof GroupJsonSchema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_DIR = path.join(__dirname, '../../groups');

export async function loadGroupConfig(groupName: string): Promise<GroupJsonConfig> {
  const configPath = path.join(GROUPS_DIR, groupName, 'group.json');
  if (!existsSync(configPath)) return {};

  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  return GroupJsonSchema.parse(JSON.parse(text));
}
