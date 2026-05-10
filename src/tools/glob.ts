import { glob } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  pattern: Type.String({
    description: "検索するファイルパターン（例: src/**/*.ts）",
  }),
  path: Type.String({
    description:
      "検索の起点となるディレクトリ（デフォルト: カレントディレクトリ）",
    default: ".",
  }),
});

export const globTool: AgentTool<typeof parameters> = {
  name: "glob",
  label: "Glob Search",
  description: "指定したパターンに一致するファイルパスを検索する",
  parameters,
  execute: async (_id, { pattern, path }) => {
    const entries: string[] = [];
    for await (const entry of glob(pattern, { cwd: path })) {
      entries.push(entry);
    }
    if (entries.length === 0) {
      return {
        content: [
          { type: "text", text: "一致するファイルが見つかりませんでした" },
        ],
        details: { pattern, path, count: 0 },
      };
    }
    return {
      content: [{ type: "text", text: entries.join("\n") }],
      details: { pattern, path, count: entries.length },
    };
  },
};
