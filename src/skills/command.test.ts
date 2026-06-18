import { describe, expect, it } from "vitest";
import { formatSkillCommandPrompt, parseSkillCommand } from "./command.js";

describe("parseSkillCommand", () => {
  it("スキル名のみのコマンドを解析する", () => {
    expect(parseSkillCommand("./command agent-reach")).toEqual({
      skillName: "agent-reach",
      args: "",
    });
  });

  it("追加指示付きのコマンドを解析する", () => {
    expect(parseSkillCommand("./command agent-reach https://example.com を要約して")).toEqual({
      skillName: "agent-reach",
      args: "https://example.com を要約して",
    });
  });

  it("前後の空白を無視する", () => {
    expect(parseSkillCommand("  ./command session-logs  ")).toEqual({
      skillName: "session-logs",
      args: "",
    });
  });

  it("通常の会話文には一致しない", () => {
    expect(parseSkillCommand("こんにちは")).toBeNull();
  });

  it("./command で始まるがスキル名がない場合は一致しない", () => {
    expect(parseSkillCommand("./command")).toBeNull();
  });
});

describe("formatSkillCommandPrompt", () => {
  it("スキル名・本文・追加指示を含むプロンプトを組み立てる", () => {
    const result = formatSkillCommandPrompt(
      "agent-reach",
      "# agent-reach\n手順本文",
      "https://example.com を要約して",
    );
    expect(result).toContain("agent-reach");
    expect(result).toContain("手順本文");
    expect(result).toContain("https://example.com を要約して");
  });

  it("追加指示が空なら追加指示セクションを含めない", () => {
    const result = formatSkillCommandPrompt("agent-reach", "手順本文", "");
    expect(result).not.toContain("ユーザーからの追加指示");
  });
});
