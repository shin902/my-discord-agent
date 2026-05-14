import { cp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const ModelConfigSchema = z.object({
  provider: z.string(),
  modelId: z.string(),
});

export const GroupJsonSchema = z.object({
  model: ModelConfigSchema.optional(),
  tools: z.array(z.string()).optional(),
  autoReply: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
});

export type GroupJsonConfig = z.infer<typeof GroupJsonSchema>;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_DIR = path.join(__dirname, "../../groups");
const TEMPLATES_DIR = path.join(__dirname, "../../templates");

async function _dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** グループフォルダが存在しない場合は templates/group/ からコピーして作成する */
export async function ensureGroupDirs(groupNames: string[]): Promise<void> {
  const templateDir = path.join(TEMPLATES_DIR, "group");
  const hasTemplate = await _dirExists(templateDir);

  await Promise.all(
    groupNames.map(async (name) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name))
        throw new Error(`不正なグループ名: ${name}`);
      const groupDir = path.join(GROUPS_DIR, name);
      if (await _dirExists(groupDir)) return;
      if (hasTemplate) {
        await cp(templateDir, groupDir, { recursive: true });
      }
      console.log(`[group-config] グループフォルダを作成しました: ${name}`);
    }),
  );
}

/** group.json の skills リストに対して、未コピーのスキルを templates/SKILLS/ からコピーする */
export async function ensureGroupSkills(
  groupName: string,
  skills: string[],
): Promise<void> {
  if (skills.length === 0) return;
  const skillsTemplateDir = path.join(TEMPLATES_DIR, "SKILLS");

  await Promise.all(
    skills.map(async (skill) => {
      const dest = path.join(GROUPS_DIR, groupName, "SKILLS", skill);
      if (await _dirExists(dest)) return;
      const src = path.join(skillsTemplateDir, skill);
      if (!(await _dirExists(src))) return;
      await cp(src, dest, { recursive: true });
      console.log(
        `[group-config] スキルをコピーしました: ${groupName}/${skill}`,
      );
    }),
  );
}

const _configCache = new Map<string, GroupJsonConfig>();
const _promptCache = new Map<string, string | null>();

async function _loadGroupConfigFromFile(
  groupName: string,
): Promise<GroupJsonConfig> {
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName))
    throw new Error(`不正なグループ名: ${groupName}`);
  const configPath = path.join(GROUPS_DIR, groupName, "group.json");
  let text: string;
  try {
    text = await readFile(configPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`グループ設定の JSON が不正です (${groupName})`);
  }
  const result = GroupJsonSchema.safeParse(parsed);
  if (!result.success)
    throw new Error(
      `グループ設定が不正です (${groupName}): ${result.error.message}`,
    );
  return result.data;
}

async function _loadGroupSystemPromptFromFile(
  groupName: string,
): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName))
    throw new Error(`不正なグループ名: ${groupName}`);
  const promptPath = path.join(GROUPS_DIR, groupName, "AGENTS.md");
  try {
    return await readFile(promptPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** 起動時に全グループの設定を一括読み込みしてキャッシュし、config の Map を返す */
export async function initGroupConfigs(
  groupNames: string[],
): Promise<Map<string, GroupJsonConfig>> {
  await Promise.all(
    groupNames.map(async (name) => {
      const [config, prompt] = await Promise.all([
        _loadGroupConfigFromFile(name),
        _loadGroupSystemPromptFromFile(name),
      ]);
      await ensureGroupSkills(name, config.skills ?? []);
      _configCache.set(name, config);
      _promptCache.set(name, prompt);
    }),
  );
  return new Map(_configCache);
}

export async function loadGroupConfig(
  groupName: string,
): Promise<GroupJsonConfig> {
  const cached = _configCache.get(groupName);
  if (cached !== undefined) return cached;
  return _loadGroupConfigFromFile(groupName);
}

export async function loadGroupSystemPrompt(
  groupName: string,
): Promise<string | null> {
  const cached = _promptCache.get(groupName);
  if (cached !== undefined) return cached;
  return _loadGroupSystemPromptFromFile(groupName);
}
