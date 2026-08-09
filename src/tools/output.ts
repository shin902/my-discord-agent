import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";

/** Maximum number of text characters returned inline to the model per tool call. */
export const TOOL_OUTPUT_CHAR_LIMIT = 50_000;

const TOOL_OUTPUT_TEMP_PREFIX = "my-discord-agent-tool-";
const TOOL_OUTPUT_FILE_NAME = "output.txt";
const EXTERNALIZED_DETAILS_KEY = "externalizedOutput";

type TextBlock = Extract<
  AgentToolResult<unknown>["content"][number],
  { type: "text" }
>;
type AnyToolResult = AgentToolResult<unknown>;

export interface ToolOutputTruncation {
  reason: "text-output-too-large";
  totalCharacters: number;
  totalBytes: number;
  totalLines: number;
  inlineCharacterLimit: typeof TOOL_OUTPUT_CHAR_LIMIT;
  lifetime: "container-run";
}

export interface ExternalizedToolOutput {
  truncated: true;
  fullOutputPath: string;
  truncation: ToolOutputTruncation;
}

function isTextBlock(
  block: AnyToolResult["content"][number],
): block is TextBlock {
  return block.type === "text";
}

function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function withExternalizedDetails(
  details: unknown,
  output: ExternalizedToolOutput,
): unknown {
  const metadata = {
    truncated: output.truncated,
    fullOutputPath: output.fullOutputPath,
    truncation: output.truncation,
  };
  if (
    typeof details === "object" &&
    details !== null &&
    !Array.isArray(details)
  ) {
    const originalDetails = details as Record<string, unknown>;
    const mergedDetails = { ...originalDetails };
    let hasMetadataCollision = false;

    for (const [key, value] of Object.entries(metadata)) {
      if (Object.hasOwn(originalDetails, key)) {
        hasMetadataCollision = true;
      } else {
        mergedDetails[key] = value;
      }
    }

    if (hasMetadataCollision) {
      // Keep upstream fields (notably grep's `truncated`) authoritative while
      // exposing the complete wrapper metadata in a dedicated namespace.
      let namespace = EXTERNALIZED_DETAILS_KEY;
      while (Object.hasOwn(originalDetails, namespace)) {
        namespace = `${namespace}Metadata`;
      }
      mergedDetails[namespace] = metadata;
    }

    return mergedDetails;
  }
  return {
    originalDetails: details,
    ...metadata,
  };
}

function buildNotice(output: ExternalizedToolOutput): string {
  return [
    "ツール出力が大きいため、全文をモデルへ返さずコンテナ内の一時ファイルへ保存しました。",
    `保存先: ${output.fullOutputPath}`,
    `元サイズ: ${output.truncation.totalCharacters} 文字 (${output.truncation.totalBytes} bytes)`,
    `切り詰め理由: テキスト出力が上限 ${output.truncation.inlineCharacterLimit} 文字を超えたため（全文は保存済み）`,
    "このパスは現在のコンテナ実行中（current container run）のみ有効です。",
    "",
    "必要な箇所だけ読む方法:",
    `- grep({"pattern":"検索語","path":"${output.fullOutputPath}"}) で対象を絞る。`,
    `- 先頭からは read({"path":"${output.fullOutputPath}","startLine":1,"lineCount":200}) を使う。`,
    `- 末尾からは read({"path":"${output.fullOutputPath}","tailCount":200}) を使う。`,
    `- 全文を確認する場合は read の startLine/lineCount で連続した範囲を先頭から順番に読み、最後まで網羅する。`,
  ].join("\n");
}

async function persistOutput(text: string): Promise<string> {
  const directory = await mkdtemp(join("/tmp", TOOL_OUTPUT_TEMP_PREFIX));
  await chmod(directory, 0o700);

  // The directory is unique and the filename is fixed, so neither the path nor
  // its name contains tool arguments or other user-controlled text.
  const fullOutputPath = join(directory, TOOL_OUTPUT_FILE_NAME);
  await writeFile(fullOutputPath, text, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(fullOutputPath, 0o600);
  return fullOutputPath;
}

/**
 * Persist a large textual tool result in the sandbox and replace its inline
 * content with instructions for targeted grep/read calls.
 *
 * This runs in the agent container because tool execution and registry
 * resolution happen there. The temporary directory is mode 0700 and the file
 * is mode 0600; no host filesystem path is involved.
 */
export async function externalizeLargeToolResult(
  result: AnyToolResult,
): Promise<AnyToolResult> {
  const text = result.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("");
  if (text.length <= TOOL_OUTPUT_CHAR_LIMIT) return result;

  const fullOutputPath = await persistOutput(text);
  const output: ExternalizedToolOutput = {
    truncated: true,
    fullOutputPath,
    truncation: {
      reason: "text-output-too-large",
      totalCharacters: text.length,
      totalBytes: Buffer.byteLength(text, "utf8"),
      totalLines: countLines(text),
      inlineCharacterLimit: TOOL_OUTPUT_CHAR_LIMIT,
      lifetime: "container-run",
    },
  };

  let noticeInserted = false;
  const content: AnyToolResult["content"] = [];
  for (const block of result.content) {
    if (!isTextBlock(block)) {
      content.push(block);
      continue;
    }
    if (!noticeInserted) {
      noticeInserted = true;
      content.push({ type: "text", text: buildNotice(output) });
    }
  }

  return {
    ...result,
    content,
    details: withExternalizedDetails(result.details, output),
  };
}

const wrappedTools = new WeakSet<object>();

/**
 * Add the common large-output boundary to a tool while preserving its object
 * identity for callers that keep a registry reference.
 */
export function wrapToolOutput<T extends AgentTool>(tool: T): T {
  if (wrappedTools.has(tool)) return tool;

  const originalExecute = tool.execute;
  tool.execute = (async (
    toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ) => {
    const result = await originalExecute.call(
      tool,
      toolCallId,
      args as never,
      signal,
      onUpdate,
    );
    return externalizeLargeToolResult(result);
  }) as T["execute"];
  wrappedTools.add(tool);
  return tool;
}
