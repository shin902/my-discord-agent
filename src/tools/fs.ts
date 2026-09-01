import { createReadStream } from "node:fs";
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
      "Path to read, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
  }),
  startLine: Type.Optional(
    Type.Integer({
      description:
        "1-based line number to start reading from, through EOF unless lineCount is also set.",
      minimum: 1,
    }),
  ),
  lineCount: Type.Optional(
    Type.Integer({
      description:
        "Number of lines to return. If startLine is omitted, reading starts at the beginning.",
      minimum: 1,
    }),
  ),
  tailCount: Type.Optional(
    Type.Integer({
      description:
        "Number of lines to return from the end. Cannot be combined with startLine or lineCount.",
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

type StreamSelectedLines = SelectedLines & {
  size: number;
};

function countLines(raw: string): number {
  if (raw === "") return 0;
  return raw.split("\n").length - (raw.endsWith("\n") ? 1 : 0);
}

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

/**
 * Read a ranged text result incrementally so source-file size does not affect
 * memory usage. The requested output is necessarily retained; an unbounded
 * startLine-only range therefore retains its full suffix. A very long line
 * being scanned is also necessarily retained while its LF is located.
 */
async function selectLinesFromStream(
  fp: string,
  range: ReadRange,
): Promise<StreamSelectedLines> {
  const { startLine, lineCount, tailCount } = range;
  const selectionStart = startLine ?? 1;
  const selectedLines: string[] = [];
  const tailLines: string[] = [];
  let tailStart = 0;
  let totalLines = 0;
  let size = 0;

  const addLine = (line: string): void => {
    totalLines += 1;
    if (tailCount !== undefined) {
      if (tailLines.length < tailCount) {
        tailLines.push(line);
      } else {
        tailLines[tailStart] = line;
        tailStart = (tailStart + 1) % tailCount;
      }
      return;
    }

    if (
      totalLines >= selectionStart &&
      (lineCount === undefined || totalLines - selectionStart < lineCount)
    ) {
      selectedLines.push(line);
    }
  };

  const stream = createReadStream(fp, { encoding: "utf8" });
  let remainder = "";
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    size += text.length;
    const data = remainder + text;
    let lineStart = 0;
    while (true) {
      const newline = data.indexOf("\n", lineStart);
      if (newline === -1) break;
      addLine(data.slice(lineStart, newline));
      lineStart = newline + 1;
    }
    remainder = data.slice(lineStart);
  }
  if (remainder !== "") {
    addLine(remainder);
  }

  if (startLine !== undefined && startLine > totalLines) {
    throw new Error(
      `startLine ${startLine} は EOF を超えています（全 ${totalLines} 行）`,
    );
  }

  let first = 0;
  let returnedLines = selectedLines;
  if (tailCount !== undefined) {
    first = Math.max(0, totalLines - tailCount);
    returnedLines =
      tailStart === 0
        ? tailLines
        : [...tailLines.slice(tailStart), ...tailLines.slice(0, tailStart)];
  } else if (startLine !== undefined) {
    first = startLine - 1;
  }

  const returnedLineCount = returnedLines.length;
  const actualStartLine = returnedLineCount === 0 ? 0 : first + 1;
  const actualEndLine = returnedLineCount === 0 ? 0 : first + returnedLineCount;

  return {
    text: returnedLines.join("\n"),
    startLine: actualStartLine,
    endLine: actualEndLine,
    returnedLineCount,
    totalLines,
    eof: actualEndLine === totalLines,
    size,
  };
}

export const readTool: AgentTool<typeof readParameters> = {
  name: "read",
  label: "Read File",
  description:
    "Read a file in the workspace or an additional mounted path. Use startLine and lineCount for a line range, lineCount alone for lines from the beginning, startLine alone for the suffix from that line, or tailCount for lines from the end. tailCount cannot be combined with startLine or lineCount. The result includes file size, total line count, and the returned range. For large files, read consecutive bounded ranges instead of the whole file.",
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

    if (hasRange) {
      const selected = await selectLinesFromStream(fp, {
        startLine,
        lineCount,
        tailCount,
      });
      return {
        content: [{ type: "text", text: selected.text }],
        details: {
          path: safePath,
          size: selected.size,
          characters: selected.size,
          returnedCharacters: selected.text.length,
          startLine: selected.startLine,
          endLine: selected.endLine,
          returnedLineCount: selected.returnedLineCount,
          totalLines: selected.totalLines,
          eof: selected.eof,
        },
      };
    }

    // Unbounded reads retain the existing full-output behavior.
    const raw = await readFile(fp, "utf-8");
    const selected = selectLines(raw, {});
    return {
      content: [{ type: "text", text: raw }],
      details: {
        path: safePath,
        size: raw.length,
        characters: raw.length,
        returnedCharacters: raw.length,
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
      "Path to write, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
  }),
  content: Type.String({ description: "Content to write." }),
});

export const writeTool: AgentTool<typeof writeParameters> = {
  name: "write",
  label: "Write File",
  description:
    "Create or overwrite a file in the workspace or an additional mounted path.",
  parameters: writeParameters,
  execute: async (_toolCallId, { path, content }) => {
    const safePath = sanitizePath(path);
    const fp = fullPath(safePath);
    await mkdir(dirname(fp), { recursive: true });
    await writeFile(fp, content, "utf-8");
    const lines = countLines(content);
    return {
      content: [
        {
          type: "text",
          text: `書き込み完了: ${safePath} (${content.length} 文字, ${lines} 行)`,
        },
      ],
      details: {
        path: safePath,
        size: content.length,
        characters: content.length,
        lines,
      },
    };
  },
};

const listParameters = Type.Object({
  path: Type.String({
    description:
      "Directory path to list, relative to the workspace root or an absolute path for an additional mount such as /obsidian. Use an empty string for the workspace root.",
    default: "",
  }),
});

export const listTool: AgentTool<typeof listParameters> = {
  name: "list",
  label: "List Files",
  description:
    "List files and directories in the workspace or an additional mounted path.",
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
      "Path to edit, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
  }),
  oldString: Type.String({ description: "String to replace." }),
  newString: Type.String({ description: "Replacement string." }),
});

export const editTool: AgentTool<typeof editParameters> = {
  name: "edit",
  label: "Edit File",
  description: "Edit part of a file by replacing a string.",
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
    const lines = countLines(updated);
    return {
      content: [
        {
          type: "text",
          text: `編集完了: ${safePath} (${count} 箇所置換, ${updated.length} 文字, ${lines} 行)`,
        },
      ],
      details: {
        path: safePath,
        replacements: count,
        size: updated.length,
        characters: updated.length,
        lines,
      },
    };
  },
};

const globParameters = Type.Object({
  pattern: Type.String({
    description: "Glob pattern, for example **/*.ts.",
  }),
  path: Type.String({
    description:
      "Base directory for the search, relative to the workspace root or an absolute path for an additional mount such as /obsidian. Use an empty string for the workspace root.",
    default: "",
  }),
});

export const globTool: AgentTool<typeof globParameters> = {
  name: "glob",
  label: "Glob",
  description: "Find files using a glob pattern.",
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
    description: "Regular expression pattern to search for.",
  }),
  path: Type.String({
    description:
      "File or directory to search, relative to the workspace root or an absolute path for an additional mount such as /obsidian.",
  }),
  glob: Type.Optional(
    Type.String({
      description: "Optional glob pattern used to filter files, for example *.ts.",
    }),
  ),
  maxResults: Type.Optional(
    Type.Number({
      description: `Maximum number of matches to return. Defaults to ${GREP_MAX_RESULTS}.`,
      minimum: 1,
    }),
  ),
});

export const grepTool: AgentTool<typeof grepParameters> = {
  name: "grep",
  label: "Grep",
  description: "Search files with a regular expression.",
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
