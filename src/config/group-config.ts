import { z } from 'zod';
import { readFile } from 'fs/promises';
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
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName)) throw new Error(`不正なグループ名: ${groupName}`);
  const configPath = path.join(GROUPS_DIR, groupName, 'group.json');
  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return GroupJsonSchema.parse(JSON.parse(text));
}

/** groups/<groupName>/AGENTS.md を読み込む。ファイルがなければ null を返す。 */
export async function loadGroupSystemPrompt(groupName: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName)) throw new Error(`不正なグループ名: ${groupName}`);
  const promptPath = path.join(GROUPS_DIR, groupName, 'AGENTS.md');
  try {
    return await readFile(promptPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
