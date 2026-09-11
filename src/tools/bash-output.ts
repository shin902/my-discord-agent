import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { finished } from "node:stream/promises";

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExecOutputCallback } from "./exec.js";
import { TOOL_OUTPUT_CHAR_LIMIT } from "./output.js";

const TEMP_PREFIX = "my-discord-agent-tool-";
const STORAGE_ERROR = "コマンド出力の保存に失敗しました";
const PREVIEW_LIMIT = 8_000;
type Source = "stdout" | "stderr";
type Reason = "text-output-too-large" | "command-output";
type Details = {
  truncated: true;
  fullOutputPath: string;
  truncation: {
    reason: Reason;
    totalCharacters: number;
    totalBytes: number;
    totalLines: number;
    inlineCharacterLimit: typeof TOOL_OUTPUT_CHAR_LIMIT;
    lifetime: "container-run";
  };
  stdoutBytes: number;
  stderrBytes: number;
};
function errorOf(value: unknown, fallback: string): Error {
  return value instanceof Error
    ? value
    : new Error(value ? String(value) : fallback);
}

function newlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; ) {
    count += 1;
    index = text.indexOf("\n", index + 1);
  }
  return count;
}

export class BashOutputCapture {
  private readonly stream: WriteStream;
  private readonly blocked = new Set<NodeJS.ReadableStream>();
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private characters = 0;
  private bytes = 0;
  private lineBreaks = 0;
  private endsWithNewline = false;
  private head = "";
  private tail = "";
  private lastSource: Source | undefined;
  private large = false;
  storageFailure: Error | undefined;
  private reportExecutionFailure: ((error: Error) => void) | undefined;

  constructor(
    private readonly directory: string,
    readonly fullOutputPath: string,
  ) {
    this.stream = createWriteStream(fullOutputPath, {
      flags: "wx",
      mode: 0o600,
    });
    this.stream.on("drain", () => {
      for (const source of this.blocked) source.resume();
      this.blocked.clear();
    });
    this.stream.on("error", this.recordStorageFailure);
  }

  get hasOutput(): boolean {
    return this.stdoutBytes > 0 || this.stderrBytes > 0;
  }

  get isLarge(): boolean {
    return this.large;
  }

  readonly onStdout: ExecOutputCallback = (chunk, stream, reportError) =>
    this.append("stdout", chunk, stream, reportError);
  readonly onStderr: ExecOutputCallback = (chunk, stream, reportError) =>
    this.append("stderr", chunk, stream, reportError);

  async ready(): Promise<void> {
    await once(this.stream, "open");
  }

  async finish(): Promise<void> {
    this.reportExecutionFailure = undefined;
    if (this.storageFailure) throw this.storageFailure;
    this.stream.end();
    await finished(this.stream);
  }

  async cleanup(): Promise<void> {
    for (const source of this.blocked) source.resume();
    this.blocked.clear();
    this.stream.destroy();
    await rm(this.directory, { recursive: true, force: true });
  }

  async result(details: unknown): Promise<AgentToolResult<unknown>> {
    if (!this.hasOutput) {
      return { content: [{ type: "text", text: "(出力なし)" }], details };
    }
    if (!this.large) {
      const text = await this.readText();
      return {
        content: [{ type: "text", text: text || "(出力なし)" }],
        details,
      };
    }
    const output = this.details();
    return {
      content: [{ type: "text", text: this.notice(output, this.preview()) }],
      details: { ...(details as Record<string, unknown>), ...output },
    };
  }

  async error(cause: unknown): Promise<Error> {
    if (this.storageFailure) return new Error(STORAGE_ERROR);

    const text = this.hasOutput
      ? this.large
        ? this.preview()
        : await this.readText()
      : "";
    const primary = errorOf(cause, "コマンド実行エラー");
    const message = [
      primary.message === "Command failed" ? undefined : primary.message,
      text && (this.large ? `出力プレビュー（先頭・末尾）:\n\n${text}` : text),
      this.hasOutput ? this.notice(this.details("command-output")) : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");
    const failure = new Error(message || "コマンド実行エラー", {
      cause: primary,
    }) as Error & Record<string, unknown>;
    if (this.hasOutput) Object.assign(failure, this.details("command-output"));
    return failure;
  }

  private append(
    source: Source,
    chunk: string,
    input: NodeJS.ReadableStream,
    reportError?: (error: Error) => void,
  ): void {
    if (!chunk || this.storageFailure) return;
    this.reportExecutionFailure ??= reportError;
    const size = Buffer.byteLength(chunk, "utf8");
    if (source === "stdout") this.stdoutBytes += size;
    else this.stderrBytes += size;

    const text = this.format(source, chunk);
    this.characters += text.length;
    this.bytes += Buffer.byteLength(text, "utf8");
    this.lineBreaks += newlines(text);
    this.endsWithNewline = text.endsWith("\n");
    if (this.head.length < PREVIEW_LIMIT) {
      this.head += text.slice(0, PREVIEW_LIMIT - this.head.length);
    }
    this.tail = `${this.tail}${text}`.slice(-PREVIEW_LIMIT);
    this.large ||= this.characters > TOOL_OUTPUT_CHAR_LIMIT;
    try {
      if (
        !this.stream.write(text, (error?: Error | null) => {
          if (error) this.recordStorageFailure(error);
        })
      ) {
        input.pause();
        this.blocked.add(input);
      }
    } catch (error) {
      this.recordStorageFailure(error);
    }
  }

  private format(source: Source, chunk: string): string {
    if (source === this.lastSource) return chunk;
    const first = this.lastSource === undefined;
    this.lastSource = source;
    return first && source === "stdout"
      ? chunk
      : `${first ? "" : "\n"}${source}:\n${chunk}`;
  }

  private async readText(): Promise<string> {
    return (await readFile(this.fullOutputPath, "utf8")).trim();
  }

  private preview(): string {
    return `${this.head}\n... (中間の出力は省略されています) ...\n${this.tail}`;
  }

  private details(reason: Reason = "text-output-too-large"): Details {
    return {
      truncated: true,
      fullOutputPath: this.fullOutputPath,
      truncation: {
        reason,
        totalCharacters: this.characters,
        totalBytes: this.bytes,
        totalLines:
          this.characters === 0
            ? 0
            : this.lineBreaks + (this.endsWithNewline ? 0 : 1),
        inlineCharacterLimit: TOOL_OUTPUT_CHAR_LIMIT,
        lifetime: "container-run",
      },
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
    };
  }

  private notice(output: Details, preview?: string): string {
    return [
      preview ? `出力プレビュー（先頭・末尾）:\n\n${preview}` : undefined,
      "コマンド出力をコンテナ内の一時ファイルへ保存しました。",
      `保存先: ${output.fullOutputPath}`,
      `元サイズ: ${output.truncation.totalCharacters} 文字 / ${output.truncation.totalLines} 行 (${output.truncation.totalBytes} bytes)`,
      `stdout: ${output.stdoutBytes} bytes / stderr: ${output.stderrBytes} bytes`,
      "このパスは現在のコンテナ実行中（current container run）のみ有効です。",
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n");
  }

  private readonly recordStorageFailure = (value: unknown): void => {
    if (this.storageFailure) return;
    this.storageFailure = errorOf(value, "Tool output file write failed");
    for (const source of this.blocked) source.resume();
    this.blocked.clear();
    this.reportExecutionFailure?.(this.storageFailure);
  };
}

export async function createBashOutputCapture(): Promise<BashOutputCapture> {
  const directory = await mkdtemp(join("/tmp", TEMP_PREFIX));
  let capture: BashOutputCapture | undefined;
  try {
    await chmod(directory, 0o700);
    const path = join(directory, "output.txt");
    capture = new BashOutputCapture(directory, path);
    await capture.ready();
    await chmod(path, 0o600);
    return capture;
  } catch (error) {
    await (capture
      ? capture.cleanup()
      : rm(directory, { recursive: true, force: true })
    ).catch(() => {});
    throw errorOf(error, "Could not create bash output file");
  }
}
