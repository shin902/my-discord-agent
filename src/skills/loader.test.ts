import { describe, expect, it } from "vitest";
import { ConfigurationError } from "../utils/error.js";
import { loadSkills, parseYamlFrontmatter } from "./loader.js";

describe("parseYamlFrontmatter", () => {
  it("YAML frontmatter をパースする", () => {
    const content = `---
name: code-review
description: コードレビューを実行する
---

# コードレビュー

レビュー手順...
`;
    const result = parseYamlFrontmatter(content);
    expect(result.frontmatter).toEqual({
      name: "code-review",
      description: "コードレビューを実行する",
    });
    expect(result.body).toBe("# コードレビュー\n\nレビュー手順...");
  });

  it("frontmatter がない場合は空オブジェクトを返す", () => {
    const content = "# タイトル\n\n本文";
    const result = parseYamlFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it("閉じタグがない場合は空オブジェクトを返す", () => {
    const content = "---\nname: foo\n";
    const result = parseYamlFrontmatter(content);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe(content);
  });

  it("クォート付きの値をパースする", () => {
    const content = `---
name: "skill name"
description: 'skill desc'
---
body`;
    const result = parseYamlFrontmatter(content);
    expect(result.frontmatter).toEqual({
      name: "skill name",
      description: "skill desc",
    });
  });

  it("コメント行を無視する", () => {
    const content = `---
# コメント
name: foo
---
body`;
    const result = parseYamlFrontmatter(content);
    expect(result.frontmatter).toEqual({ name: "foo" });
  });
});

describe("loadSkills", () => {
  it("selection 未指定の場合はスキルディレクトリを読まずに空配列を返す", async () => {
    const skills = await loadSkills("/tmp/nonexistent-skills-dir-12345");
    expect(skills).toEqual([]);
  });

  it('"*" 指定時にスキルディレクトリが存在しない場合は空配列を返す', async () => {
    const skills = await loadSkills("/tmp/nonexistent-skills-dir-12345", "*");
    expect(skills).toEqual([]);
  });

  it("allowlist 指定時にスキルディレクトリ自体が存在しない場合は throw する", async () => {
    await expect(
      loadSkills("/tmp/nonexistent-skills-dir-12345", ["foo"]),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("allowlist に指定したスキルのディレクトリが SKILLS 内に存在しない場合は設定エラーを throw する", async () => {
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/skills-test-`);
    await mkdir(`${dir}/existing-skill`);
    // SKILL.md なしで allowlist に含まれていないスキルは無視されるが、
    // allowlist に含まれていないディレクトリは存在してもロードされない
    await expect(loadSkills(dir, ["missing-skill"])).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it("allowlist に指定したディレクトリに SKILL.md がない場合は設定エラーを throw する", async () => {
    const { mkdtemp, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/skills-test-`);
    await mkdir(`${dir}/missing-skill`);

    await expect(loadSkills(dir, ["missing-skill"])).rejects.toBeInstanceOf(
      ConfigurationError,
    );
  });

  it('"*" 指定時は SKILLS 配下の全スキルをロードする', async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/skills-test-`);
    await mkdir(`${dir}/skill-a`);
    await mkdir(`${dir}/skill-b`);
    await writeFile(
      `${dir}/skill-a/SKILL.md`,
      "---\nname: skill-a\ndescription: A\n---\n",
    );
    await writeFile(
      `${dir}/skill-b/SKILL.md`,
      "---\nname: skill-b\ndescription: B\n---\n",
    );

    const skills = await loadSkills(dir, "*");
    expect(skills.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
  });
});
