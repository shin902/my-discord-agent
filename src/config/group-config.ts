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

const _configCache = new Map<string, GroupJsonConfig>();
const _promptCache = new Map<string, string | null>();

async function _loadGroupConfigFromFile(groupName: string): Promise<GroupJsonConfig> {
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName)) throw new Error(`不正なグループ名: ${groupName}`);
  const configPath = path.join(GROUPS_DIR, groupName, 'group.json');
  let text: string;
  try {
    text = await readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`グループ設定の JSON が不正です (${groupName})`);
  }
  const result = GroupJsonSchema.safeParse(parsed);
  if (!result.success) throw new Error(`グループ設定が不正です (${groupName}): ${result.error.message}`);
  return result.data;
}

async function _loadGroupSystemPromptFromFile(groupName: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName)) throw new Error(`不正なグループ名: ${groupName}`);
  const promptPath = path.join(GROUPS_DIR, groupName, 'AGENTS.md');
  try {
    return await readFile(promptPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 起動時に全グループの設定を一括読み込みしてキャッシュする */
export async function initGroupConfigs(groupNames: string[]): Promise<void> {
  await Promise.all(
    groupNames.map(async (name) => {
      _configCache.set(name, await _loadGroupConfigFromFile(name));
      _promptCache.set(name, await _loadGroupSystemPromptFromFile(name));
    }),
  );
}

export async function loadGroupConfig(groupName: string): Promise<GroupJsonConfig> {
  if (_configCache.has(groupName)) return _configCache.get(groupName)!;
  return _loadGroupConfigFromFile(groupName);
}

export async function loadGroupSystemPrompt(groupName: string): Promise<string | null> {
  if (_promptCache.has(groupName)) return _promptCache.get(groupName)!;
  return _loadGroupSystemPromptFromFile(groupName);
}
