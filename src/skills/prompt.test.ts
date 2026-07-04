import { describe, expect, it } from "vitest";
import { formatSkillsForPrompt } from "./prompt.js";

describe("formatSkillsForPrompt", () => {
  it("スキルが空の場合は空文字を返す", () => {
    expect(formatSkillsForPrompt([])).toBe("");
  });

  it("XML形式でスキル一覧を生成する", () => {
    const skills = [
      {
        name: "code-review",
        description: "コードレビューを実行する",
        location: "/workspace/skills/code-review/SKILL.md",
      },
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("<available_skills>");
    expect(result).toContain("</available_skills>");
    expect(result).toContain("<name>code-review</name>");
    expect(result).toContain(
      "<description>コードレビューを実行する</description>",
    );
    expect(result).toContain(
      "<location>/workspace/skills/code-review/SKILL.md</location>",
    );
    expect(result).toContain("SKILL.md を `read` で読み");
  });

  it("複数のスキルを含める", () => {
    const skills = [
      { name: "a", description: "desc a", location: "/a/SKILL.md" },
      { name: "b", description: "desc b", location: "/b/SKILL.md" },
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("<name>a</name>");
    expect(result).toContain("<name>b</name>");
  });

  it("XML特殊文字をエスケープする", () => {
    const skills = [
      {
        name: "test",
        description: '5 < 10 & "foo"',
        location: "/test/SKILL.md",
      },
    ];
    const result = formatSkillsForPrompt(skills);
    expect(result).toContain("5 &lt; 10 &amp; &quot;foo&quot;");
  });
});
