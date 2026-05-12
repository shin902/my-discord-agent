import { mkdir, readdir,readFile, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const WORKSPACE = "/workspace";
const MAX_OUTPUT_CHARS = 8000;

function sanitizePath(raw: string): string {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const normalized = normalize(withoutPrefix);
  if (normalized.startsWith("..")) {
    throw new Error(`アクセス拒否: ボリューム外へのパスは許可されていません (${raw})`);
  }
  return normalized === "." ? "" : normalized;
}

function fullPath(safePath: string): string {
  return safePath === "" ? WORKSPACE : join(WORKSPACE, safePath);
}

const readParameters = Type.Object({
  path: Type.String({ description: "読み込むファイルのパス（ワークスペースルートからの相対パス）" }),
});

export const readTool: AgentTool<typeof readParameters> = {
  name: "read",
  label: "Read File",
  description: "ワークスペース内のファイル内容を読み込む",
  parameters: readParameters,
  execute: async (_toolCallId, { path }) => {
    const safePath = sanitizePath(path);
    const content = await readFile(fullPath(safePath), "utf-8");
    const truncated = content.slice(0, MAX_OUTPUT_CHARS);
    const text =
      truncated.length < content.length
        ? `${truncated}\n\n... (省略: 合計 ${content.length} 文字)`
        : truncated;
    return {
      content: [{ type: "text", text }],
      details: { path: safePath, size: content.length },
    };
  },
};

const writeParameters = Type.Object({
  path: Type.String({ description: "書き込むファイルのパス（ワークスペースルートからの相対パス）" }),
  content: Type.String({ description: "書き込む内容" }),
});

export const writeTool: AgentTool<typeof writeParameters> = {
  name: "write",
  label: "Write File",
  description: "ワークスペース内にファイルを作成または上書きする",
  parameters: writeParameters,
  execute: async (_toolCallId, { path, content }) => {
    const safePath = sanitizePath(path);
    const fp = fullPath(safePath);
    await mkdir(dirname(fp), { recursive: true });
    await writeFile(fp, content, "utf-8");
    return {
      content: [{ type: "text", text: `書き込み完了: ${safePath}` }],
      details: { path: safePath, size: content.length },
    };
  },
};

const listParameters = Type.Object({
  path: Type.String({
    description:
      "一覧するディレクトリのパス（ワークスペースルートからの相対パス。空文字でルート）",
    default: "",
  }),
});

export const listTool: AgentTool<typeof listParameters> = {
  name: "list",
  label: "List Files",
  description: "ワークスペース内のファイル・ディレクトリ一覧を取得する",
  parameters: listParameters,
  execute: async (_toolCallId, { path }) => {
    const safePath = sanitizePath(path);
    const entries = await readdir(fullPath(safePath), { withFileTypes: true });
    const lines = entries.map((e) => {
      const kind = e.isDirectory() ? "dir" : "file";
      return `${kind}: ${e.name}`;
    });
    const text = lines.length === 0 ? "(空のディレクトリ)" : lines.join("\n");
    return {
      content: [{ type: "text", text }],
      details: { path: safePath, count: entries.length },
    };
  },
};

const editParameters = Type.Object({
  path: Type.String({ description: "編集するファイルのパス（ワークスペースルートからの相対パス）" }),
  oldString: Type.String({ description: "置換対象の文字列" }),
  newString: Type.String({ description: "置換後の文字列" }),
});

export const editTool: AgentTool<typeof editParameters> = {
  name: "edit",
  label: "Edit File",
  description: "ワークスペース内のファイルの一部を文字列置換で編集する",
  parameters: editParameters,
  execute: async (_toolCallId, { path, oldString, newString }) => {
    const safePath = sanitizePath(path);
    const fp = fullPath(safePath);
    const original = await readFile(fp, "utf-8");
    if (!original.includes(oldString)) {
      throw new Error(`置換対象が見つかりません: ${oldString.slice(0, 50)}`);
    }
    const updated = original.replaceAll(oldString, newString);
    await writeFile(fp, updated, "utf-8");
    const count = original.split(oldString).length - 1;
    return {
      content: [{ type: "text", text: `編集完了: ${safePath} (${count} 箇所置換)` }],
      details: { path: safePath, replacements: count },
    };
  },
};
