import {
  cp as fsCp,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  stat as fsStat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GroupConfig, SkillSelection } from "./groups.js";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GROUPS_DIR = path.join(__dirname, "../../groups");
const TEMPLATES_DIR = path.join(__dirname, "../../templates");

export interface GroupConfigFileSystem {
  cp: (
    source: string,
    destination: string,
    options?: { recursive?: boolean },
  ) => Promise<void>;
  mkdir: (
    directory: string,
    options: { recursive: true },
  ) => Promise<string | undefined>;
  readFile: (file: string, encoding: "utf-8") => Promise<string>;
  stat: (
    file: string,
  ) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

const defaultFileSystem: GroupConfigFileSystem = {
  cp: async (source, destination, options) => {
    await fsCp(source, destination, options);
  },
  mkdir: fsMkdir,
  readFile: async (file, encoding) => fsReadFile(file, encoding),
  stat: fsStat,
};

export function createGroupConfig(
  fileSystem: GroupConfigFileSystem = defaultFileSystem,
) {
  async function _dirExists(p: string): Promise<boolean> {
    try {
      return (await fileSystem.stat(p)).isDirectory();
    } catch (err) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(err).success)
        return false;
      throw err;
    }
  }

  async function _fileExists(p: string): Promise<boolean> {
    try {
      return (await fileSystem.stat(p)).isFile();
    } catch (err) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(err).success)
        return false;
      throw err;
    }
  }

  /** グループフォルダが存在しない場合は templates/group/AGENTS.md をコピーして作成する */
  async function ensureGroupDirs(groupNames: string[]): Promise<void> {
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
            await fileSystem.mkdir(groupDir, { recursive: true });
            await fileSystem.cp(templatePath, path.join(groupDir, "AGENTS.md"));
            console.log(
              `[group-config] グループフォルダを作成しました: ${name}`,
            );
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
  async function ensureGroupSkills(
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
          await fileSystem.cp(src, dest, { recursive: true });
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
      return await fileSystem.readFile(promptPath, "utf-8");
    } catch (err) {
      if (z.object({ code: z.literal("ENOENT") }).safeParse(err).success)
        return null;
      throw err;
    }
  }

  /** 起動時に全グループのシステムプロンプトを一括読み込みしてキャッシュし、skills をコピーする */
  async function initGroupPrompts(groups: GroupConfig[]): Promise<void> {
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

  async function loadGroupSystemPrompt(
    groupName: string,
  ): Promise<string | null> {
    const cached = _promptCache.get(groupName);
    if (cached !== undefined) return cached;
    return _loadGroupSystemPromptFromFile(groupName);
  }

  return {
    ensureGroupDirs,
    ensureGroupSkills,
    initGroupPrompts,
    loadGroupSystemPrompt,
  };
}

const defaultGroupConfig = createGroupConfig();
export const ensureGroupDirs = defaultGroupConfig.ensureGroupDirs;
export const ensureGroupSkills = defaultGroupConfig.ensureGroupSkills;
export const initGroupPrompts = defaultGroupConfig.initGroupPrompts;
export const loadGroupSystemPrompt = defaultGroupConfig.loadGroupSystemPrompt;
