import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  path: Type.String({
    description:
      "ツリー表示するディレクトリのパス（デフォルト: カレントディレクトリ）",
    default: ".",
  }),
  depth: Type.Number({
    description: "最大深さ（デフォルト: 3）",
    default: 3,
  }),
});

async function buildTree(
  dirPath: string,
  prefix: string,
  depth: number,
  maxDepth: number,
): Promise<string[]> {
  if (depth > maxDepth) return [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const isLast = i === entries.length - 1;
    const branch = isLast ? "└── " : "├── ";
    lines.push(`${prefix}${branch}${e.name}`);
    if (e.isDirectory()) {
      const childPrefix = prefix + (isLast ? "    " : "│   ");
      const childLines = await buildTree(
        join(dirPath, e.name),
        childPrefix,
        depth + 1,
        maxDepth,
      );
      lines.push(...childLines);
    }
  }
  return lines;
}

export const treeTool: AgentTool<typeof parameters> = {
  name: "tree",
  label: "Directory Tree",
  description: "指定したディレクトリのツリー構造を取得する",
  parameters,
  execute: async (_id, { path, depth }) => {
    const info = await stat(path);
    if (!info.isDirectory()) {
      throw new Error(`ディレクトリではありません: ${path}`);
    }
    const lines = await buildTree(path, "", 1, depth);
    return {
      content: [{ type: "text", text: [path, ...lines].join("\n") }],
      details: { path, depth },
    };
  },
};
