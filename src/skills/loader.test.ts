import { describe, expect, it } from "vitest";
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
  it("スキルディレクトリが存在しない場合は空配列を返す", async () => {
    const skills = await loadSkills("/tmp/nonexistent-skills-dir-12345");
    expect(skills).toEqual([]);
  });
});
