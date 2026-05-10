import { readFile } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  path: Type.String({ description: "検索するファイルのパス" }),
  pattern: Type.String({ description: "検索する文字列または正規表現パターン" }),
  regex: Type.Boolean({
    description: "pattern を正規表現として扱うか（デフォルト: false）",
    default: false,
  }),
});

export const grepTool: AgentTool<typeof parameters> = {
  name: "grep",
  label: "Grep File",
  description: "指定したファイル内で文字列または正規表現を検索する",
  parameters,
  execute: async (_id, { path, pattern, regex }) => {
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n");
    const re = regex ? new RegExp(pattern) : null;
    const matches: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matched = re ? re.test(line) : line.includes(pattern);
      if (matched) {
        matches.push(`${i + 1}:${line}`);
      }
    }
    if (matches.length === 0) {
      return {
        content: [{ type: "text", text: "一致する行が見つかりませんでした" }],
        details: { path, pattern, matches: 0 },
      };
    }
    return {
      content: [{ type: "text", text: matches.join("\n") }],
      details: { path, pattern, matches: matches.length },
    };
  },
};
