import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

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
  allowlist?: string[],
): Promise<Skill[]> {
  let entries: Dirent[];
  try {
    entries = (await readdir(skillsDir, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      if (allowlist) {
        for (const name of allowlist) {
          console.warn(
            `[skills] allowlist 内のスキル "${name}" が ${skillsDir} に見つかりませんでした`,
          );
        }
      }
      return [];
    }
    throw err;
  }

  const skills: Skill[] = [];

  const loadedNames = new Set<string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await readFile(skillPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    const { frontmatter } = parseYamlFrontmatter(content);
    const name = frontmatter.name || entry.name;
    const description = frontmatter.description || "";

    loadedNames.add(name);

    if (allowlist && !allowlist.includes(name)) continue;

    skills.push(
      SkillSchema.parse({
        name,
        description,
        location: skillPath,
      }),
    );
  }

  if (allowlist) {
    for (const name of allowlist) {
      if (!loadedNames.has(name)) {
        console.warn(
          `[skills] allowlist 内のスキル "${name}" が ${skillsDir} に見つかりませんでした`,
        );
      }
    }
  }

  return skills;
}
