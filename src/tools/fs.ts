import {
  glob,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { assertNoParentTraversal } from "./path-safety.js";

const WORKSPACE = "/workspace";
const GREP_MAX_RESULTS = 200;
const READ_IMAGE_BYTE_LIMIT = 10 * 1024 * 1024; // 10MB

const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// /workspace 始まりのパスはワークスペースルートからの相対パスとして扱う。
// それ以外の絶対パスは、追加マウント（例: 個人用Obsidian Vaultの /obsidian）に
// アクセスできるよう、コンテナ内の実パスとしてそのまま扱う。
// （bash ツールがすでにコンテナ内の全パスへ無制限にアクセスできるため、
// read/write 系ツールだけを /workspace 配下に閉じ込めても実質的な安全境界にはならない）
function sanitizePath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === WORKSPACE || trimmed.startsWith(`${WORKSPACE}/`)) {
    const stripped = trimmed.slice(WORKSPACE.length).replace(/^\/+/, "");
    const normalized = normalize(stripped);
    assertNoParentTraversal(
      normalized,
      raw,
      "アクセス拒否: 相対パスの .. でワークスペース外に出ることは許可されていません。ワークスペース外のファイルにアクセスする場合は絶対パスを使用してください",
    );
    return normalized === "." ? "" : normalized;
  }
  if (isAbsolute(trimmed)) {
    return normalize(trimmed);
  }
  const normalized = normalize(trimmed);
  assertNoParentTraversal(
    normalized,
    raw,
    "アクセス拒否: 相対パスの .. でワークスペース外に出ることは許可されていません。ワークスペース外のファイルにアクセスする場合は絶対パスを使用してください",
  );
  return normalized === "." ? "" : normalized;
}

function fullPath(safePath: string): string {
  if (safePath === "") return WORKSPACE;
  return isAbsolute(safePath) ? safePath : join(WORKSPACE, safePath);
}

const readParameters = Type.Object({
  path: Type.String({
    description:
      "読み込むファイルのパス（ワークスペースルートからの相対パス、または /obsidian など追加マウントを含む絶対パス）",
  }),
  startLine: Type.Optional(
    Type.Integer({
      description: "読み始める行番号（1始まり。指定した行から末尾まで）",
      minimum: 1,
    }),
  ),
  lineCount: Type.Optional(
    Type.Integer({
      description: "返す行数（1以上。startLine 省略時は先頭から）",
      minimum: 1,
    }),
  ),
  tailCount: Type.Optional(
    Type.Integer({
      description: "末尾から返す行数（1以上。startLine/lineCount と併用不可）",
      minimum: 1,
    }),
  ),
});

type ReadRange = {
  startLine?: number;
  lineCount?: number;
  tailCount?: number;
};

type SelectedLines = {
  text: string;
  startLine: number;
  endLine: number;
  returnedLineCount: number;
  totalLines: number;
  eof: boolean;
};

function validatePositiveInteger(
  name: string,
  value: number | undefined,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${name} は正の整数で指定してください`);
  }
}

function validateReadRange({
  startLine,
  lineCount,
  tailCount,
}: ReadRange): boolean {
  validatePositiveInteger("startLine", startLine);
  validatePositiveInteger("lineCount", lineCount);
  validatePositiveInteger("tailCount", tailCount);
  if (
    tailCount !== undefined &&
    (startLine !== undefined || lineCount !== undefined)
  ) {
    throw new Error("tailCount は startLine/lineCount と併用できません");
  }
  return (
    startLine !== undefined ||
    lineCount !== undefined ||
    tailCount !== undefined
  );
}

function splitLines(raw: string): string[] {
  if (raw === "") return [];
  const lines = raw.split("\n");
  if (raw.endsWith("\n")) lines.pop();
  return lines;
}

function selectLines(raw: string, range: ReadRange): SelectedLines {
  const lines = splitLines(raw);
  const totalLines = lines.length;
  const { startLine, lineCount, tailCount } = range;

  if (startLine !== undefined && startLine > totalLines) {
    throw new Error(
      `startLine ${startLine} は EOF を超えています（全 ${totalLines} 行）`,
    );
  }

  let first = 0;
  let last = totalLines;
  if (tailCount !== undefined) {
    first = Math.max(0, totalLines - tailCount);
  } else if (startLine !== undefined) {
    first = startLine - 1;
    if (lineCount !== undefined) {
      last = Math.min(totalLines, first + lineCount);
    }
  } else if (lineCount !== undefined) {
    last = Math.min(totalLines, lineCount);
  }

  const selected = lines.slice(first, last);
  const returnedLineCount = selected.length;
  const actualStartLine = returnedLineCount === 0 ? 0 : first + 1;
  const actualEndLine = returnedLineCount === 0 ? 0 : first + returnedLineCount;

  return {
    text: selected.join("\n"),
    startLine: actualStartLine,
    endLine: actualEndLine,
    returnedLineCount,
    totalLines,
    eof: actualEndLine === totalLines,
  };
}

export const readTool: AgentTool<typeof readParameters> = {
  name: "read",
  label: "Read File",
  description:
    "ワークスペース内のファイル内容を読み込む。startLine（1始まり）とlineCountで行範囲を指定でき、lineCountだけなら先頭から、startLineだけなら指定行から末尾までを返す。tailCountで末尾から読めるが、startLine/lineCountとは併用できない。大きなファイルは先頭から順番に範囲を指定して読み進める",
  parameters: readParameters,
  execute: async (_toolCallId, { path, startLine, lineCount, tailCount }) => {
    const safePath = sanitizePath(path);
    const fp = fullPath(safePath);
    const hasRange = validateReadRange({ startLine, lineCount, tailCount });

    const mimeType = IMAGE_MIME_TYPES[extname(safePath).toLowerCase()];
    if (mimeType) {
      if (hasRange) {
        throw new Error("画像ファイルでは行範囲を指定できません");
      }
      const { size } = await stat(fp);
      if (size > READ_IMAGE_BYTE_LIMIT) {
        throw new Error(
          `画像が大きすぎます (${size} bytes > ${READ_IMAGE_BYTE_LIMIT} bytes)`,
        );
      }
      const data = await readFile(fp, "base64");
      return {
        content: [{ type: "image", data, mimeType }],
        details: { path: safePath, size, mimeType },
      };
    }

    const raw = await readFile(fp, "utf-8");
    const selected = selectLines(raw, { startLine, lineCount, tailCount });
    const text = hasRange ? selected.text : raw;
    return {
      content: [{ type: "text", text }],
      details: {
        path: safePath,
        size: raw.length,
        startLine: selected.startLine,
        endLine: selected.endLine,
        returnedLineCount: selected.returnedLineCount,
        totalLines: selected.totalLines,
        eof: selected.eof,
      },
    };
  },
};

const writeParameters = Type.Object({
  path: Type.String({
    description:
      "書き込むファイルのパス（ワークスペースルートからの相対パス、または /obsidian など追加マウントを含む絶対パス）",
  }),
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
      "一覧するディレクトリのパス（ワークスペースルートからの相対パス、または /obsidian など追加マウントを含む絶対パス。空文字でルート）",
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
  path: Type.String({
    description:
      "編集するファイルのパス（ワークスペースルートからの相対パス、または /obsidian など追加マウントを含む絶対パス）",
  }),
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
    if (oldString === "") {
      throw new Error(
        "置換対象の文字列（oldString）を空にすることはできません",
      );
    }
    if (!original.includes(oldString)) {
      throw new Error(`置換対象が見つかりません: ${oldString.slice(0, 50)}`);
    }
    const updated = original.replaceAll(oldString, newString);
    await writeFile(fp, updated, "utf-8");
    const count = original.split(oldString).length - 1;
    return {
      content: [
        { type: "text", text: `編集完了: ${safePath} (${count} 箇所置換)` },
      ],
      details: { path: safePath, replacements: count },
    };
  },
};

const globParameters = Type.Object({
  pattern: Type.String({
    description: "glob パターン（例: **/*.ts）",
  }),
  path: Type.String({
    description:
      "検索のベースディレクトリ（ワークスペースルートからの相対パス、または /obsidian など追加マウントを含む絶対パス。空文字でルート）",
    default: "",
  }),
});

export const globTool: AgentTool<typeof globParameters> = {
  name: "glob",
  label: "Glob",
  description: "ワークスペース内のファイルを glob パターンで検索する",
  parameters: globParameters,
  execute: async (_toolCallId, { pattern, path }) => {
    const safePath = sanitizePath(path ?? "");
    const cwd = fullPath(safePath);
    const iterable = glob(pattern, { cwd, withFileTypes: false });
    const files: string[] = [];
    for await (const f of iterable) {
      files.push(join(safePath, f));
    }
    const text = files.join("\n");
    return {
      content: [{ type: "text", text: text || "(一致なし)" }],
      details: { pattern, path: safePath, count: files.length },
    };
  },
};

const grepParameters = Type.Object({
  pattern: Type.String({
    description: "検索する正規表現パターン",
  }),
  path: Type.String({
    description:
      "検索対象のファイルまたはディレクトリ（ワークスペースルートからの相対パス、または /obsidian など追加マウントを含む絶対パス）",
  }),
  glob: Type.Optional(
    Type.String({
      description: "ファイルフィルタの glob パターン（例: *.ts）",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: `返す最大マッチ件数（デフォルト: ${GREP_MAX_RESULTS}）`,
      minimum: 1,
    }),
  ),
});

export const grepTool: AgentTool<typeof grepParameters> = {
  name: "grep",
  label: "Grep",
  description: "ワークスペース内のファイルを正規表現で検索する",
  parameters: grepParameters,
  execute: async (
    _toolCallId,
    { pattern, path, glob: globPattern, maxResults },
  ) => {
    const limit = maxResults ?? GREP_MAX_RESULTS;
    const safePath = sanitizePath(path);
    const basePath = fullPath(safePath);
    const regex = new RegExp(pattern, "gm");

    let files: string[];
    let statInfo: Awaited<ReturnType<typeof stat>>;
    try {
      statInfo = await stat(basePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          content: [{ type: "text", text: "(一致なし)" }],
          details: { pattern, count: 0 },
        };
      }
      throw err;
    }
    if (statInfo.isFile()) {
      files = [safePath];
    } else {
      const gp = globPattern ?? "**/*";
      const iterable = glob(gp, {
        cwd: basePath,
        withFileTypes: false,
      });
      files = [];
      for await (const f of iterable) {
        files.push(join(safePath, f));
      }
    }

    const matches: Array<{ file: string; line: number; content: string }> = [];

    outer: for (const filePath of files) {
      const fp = fullPath(filePath);
      let content: string;
      try {
        content = await readFile(fp, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matches.push({ file: filePath, line: i + 1, content: lines[i] });
          if (matches.length > limit) break outer;
        }
      }
    }

    const truncated = matches.length > limit;
    const shown = truncated ? matches.slice(0, limit) : matches;
    const lines = shown.map((m) => `${m.file}:${m.line}: ${m.content}`);
    if (truncated) {
      lines.push(
        `\n[${matches.length - limit} 件省略。pattern をより具体的にするか maxResults を増やしてください]`,
      );
    }
    const text = lines.length === 0 ? "(一致なし)" : lines.join("\n");

    return {
      content: [{ type: "text", text }],
      details: { pattern, count: matches.length, truncated },
    };
  },
};
