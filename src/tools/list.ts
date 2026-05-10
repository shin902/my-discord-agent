import { readdir } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  path: Type.String({
    description:
      "一覧を取得するディレクトリのパス（デフォルト: カレントディレクトリ）",
    default: ".",
  }),
});

export const listTool: AgentTool<typeof parameters> = {
  name: "list",
  label: "List Directory",
  description: "指定したディレクトリ内のファイルとフォルダの一覧を取得する",
  parameters,
  execute: async (_id, { path }) => {
    const entries = await readdir(path, { withFileTypes: true });
    const lines = entries.map((e) => {
      const type = e.isDirectory() ? "dir" : "file";
      return `${type}\t${e.name}`;
    });
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { path, count: entries.length },
    };
  },
};
