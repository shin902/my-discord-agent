import { cp, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupConfig, SkillSelection } from "./groups.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_DIR = path.join(__dirname, "../../groups");
const TEMPLATES_DIR = path.join(__dirname, "../../templates");

async function _dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function _fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** グループフォルダが存在しない場合は templates/group/AGENTS.md をコピーして作成する */
export async function ensureGroupDirs(groupNames: string[]): Promise<void> {
  const templatePath = path.join(TEMPLATES_DIR, "group", "AGENTS.md");
  const hasTemplate = await _fileExists(templatePath);

  await Promise.all(
    groupNames.map(async (name) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(name))
        throw new Error(`不正なグループ名: ${name}`);
      const groupDir = path.join(GROUPS_DIR, name);
      if (await _dirExists(groupDir)) return;
      if (hasTemplate) {
        try {
          await mkdir(groupDir, { recursive: true });
          await cp(templatePath, path.join(groupDir, "AGENTS.md"));
          console.log(`[group-config] グループフォルダを作成しました: ${name}`);
        } catch (err) {
          console.warn(
            `[group-config] グループフォルダの作成に失敗しました: ${name}`,
            err,
          );
        }
      }
    }),
  );
}

function skillsToEnsureList(selection: SkillSelection | undefined): string[] {
  return Array.isArray(selection) ? selection : [];
}

/** skills リストに対して、未コピーのスキルを templates/SKILLS/ からコピーする */
export async function ensureGroupSkills(
  groupName: string,
  skills: string[],
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(groupName))
    throw new Error(`不正なグループ名: ${groupName}`);
  if (skills.length === 0) return;
  const skillsTemplateDir = path.join(TEMPLATES_DIR, "SKILLS");

  await Promise.all(
    skills.map(async (skill) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(skill))
        throw new Error(`不正なスキル名: ${skill}`);
      const dest = path.join(GROUPS_DIR, groupName, "SKILLS", skill);
      if (await _dirExists(dest)) return;
      const src = path.join(skillsTemplateDir, skill);
      if (!(await _dirExists(src))) {
        console.warn(
          `[group-config] スキル "${skill}" は ${skillsTemplateDir} に存在しないためコピーをスキップしました (group: ${groupName})`,
        );
        return;
      }
      try {
        await cp(src, dest, { recursive: true });
        console.log(
          `[group-config] スキルをコピーしました: ${groupName}/${skill}`,
        );
      } catch (err) {
        console.warn(
          `[group-config] スキルのコピーに失敗しました: ${groupName}/${skill}`,
          err,
        );
      }
    }),
  );
}

const _promptCache = new Map<string, string | null>();

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

/** 起動時に全グループのシステムプロンプトを一括読み込みしてキャッシュし、skills をコピーする */
export async function initGroupPrompts(groups: GroupConfig[]): Promise<void> {
  await Promise.all(
    groups.map(async (group) => {
      const [, prompt] = await Promise.all([
        ensureGroupSkills(group.name, skillsToEnsureList(group.skills)),
        _loadGroupSystemPromptFromFile(group.name),
      ]);
      _promptCache.set(group.name, prompt);
    }),
  );
}

export async function loadGroupSystemPrompt(
  groupName: string,
  options?: { refresh?: boolean },
): Promise<string | null> {
  const cached = _promptCache.get(groupName);
  if (!options?.refresh && cached !== undefined) return cached;
  return _loadGroupSystemPromptFromFile(groupName);
}
