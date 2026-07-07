import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SkillSelection } from "../config/groups.js";

export const SkillSchema = z.object({
  name: z.string(),
  description: z.string(),
  location: z.string(),
});

export type Skill = z.infer<typeof SkillSchema>;

export function parseYamlFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const trimmed = content.trim();
  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content };
  }

  const end = trimmed.indexOf("---", 3);
  if (end === -1) {
    return { frontmatter: {}, body: content };
  }

  const yaml = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trimStart();

  const frontmatter: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;
    const colonIndex = trimmedLine.indexOf(":");
    if (colonIndex === -1) continue;
    const key = trimmedLine.slice(0, colonIndex).trim();
    let value = trimmedLine.slice(colonIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

export async function loadSkills(
  skillsDir: string,
  selection?: SkillSelection,
): Promise<Skill[]> {
  // 未指定または [] は「スキルなし」。全スキルを読み込む場合は "*" を明示する。
  if (
    selection === undefined ||
    (Array.isArray(selection) && selection.length === 0)
  ) {
    return [];
  }

  const allowlist = Array.isArray(selection) ? selection : undefined;
  let entries: Dirent[];
  try {
    entries = (await readdir(skillsDir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (allowlist && allowlist.length > 0) {
        throw new Error(
          `[skills] スキルディレクトリ "${skillsDir}" が存在しません。allowlist に指定されたスキル: ${allowlist.join(", ")}`,
        );
      }
      return [];
    }
    throw err;
  }

  const skills: Skill[] = [];
  const foundDirs = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    foundDirs.add(entry.name);

    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (allowlist?.includes(entry.name)) {
          throw new Error(
            `[skills] ディレクトリ "${entry.name}" は存在しますが SKILL.md がありません (${skillPath})`,
          );
        }
        continue;
      }
      throw err;
    }

    const { frontmatter } = parseYamlFrontmatter(content);
    const name = frontmatter.name || entry.name;
    const description = frontmatter.description || "";

    if (frontmatter.name && frontmatter.name !== entry.name) {
      console.warn(
        `[skills] スキル名不一致: ディレクトリ名 "${entry.name}" とフロントマター name "${frontmatter.name}" が異なります。allowlist はディレクトリ名で照合します`,
      );
    }

    if (allowlist && !allowlist.includes(entry.name)) continue;

    skills.push(
      SkillSchema.parse({
        name,
        description,
        location: skillPath,
      }),
    );
  }

  if (allowlist) {
    const missing = allowlist.filter((name) => !foundDirs.has(name));
    if (missing.length > 0) {
      throw new Error(
        `[skills] allowlist に指定されたスキルが "${skillsDir}" に見つかりません: ${missing.join(", ")}`,
      );
    }
  }

  return skills;
}
