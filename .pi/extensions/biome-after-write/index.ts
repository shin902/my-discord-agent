import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BIOME_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".cts",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const MAX_ERROR_LENGTH = 2_000;

interface MutationResultEvent {
  toolName: string;
  input: Record<string, unknown>;
  content: Array<TextContent | ImageContent>;
  isError: boolean;
}

interface MutationContext {
  cwd: string;
  signal?: AbortSignal;
  hasUI: boolean;
  ui: {
    notify(message: string, level: "error"): void;
  };
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PiApi {
  exec(
    command: string,
    args: string[],
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<ExecResult>;
}

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

async function repositoryFile(
  cwd: string,
  inputPath: unknown,
): Promise<{ root: string; relativePath: string } | undefined> {
  if (typeof inputPath !== "string" || inputPath.length === 0) return undefined;
  if (!BIOME_EXTENSIONS.has(extname(inputPath).toLowerCase())) return undefined;

  const [root, file] = await Promise.all([
    realpath(cwd),
    realpath(resolve(cwd, inputPath)),
  ]).catch(() => []);
  if (!root || !file || !isInside(root, file)) return undefined;
  if (!(await stat(file)).isFile()) return undefined;

  return { root, relativePath: relative(root, file) };
}

function failureMessage(path: string, result: ExecResult): string {
  const output = (result.stderr || result.stdout || "No output").trim();
  const suffix = output.length > MAX_ERROR_LENGTH ? "\n… (truncated)" : "";
  return `Biome failed for ${path} (exit ${result.code}):\n${output.slice(0, MAX_ERROR_LENGTH)}${suffix}`;
}

export function createMutationHandler(pi: PiApi) {
  return async (event: MutationResultEvent, ctx: MutationContext) => {
    if (
      event.isError ||
      (event.toolName !== "write" && event.toolName !== "edit")
    ) {
      return undefined;
    }

    const file = await repositoryFile(ctx.cwd, event.input.path);
    if (!file) return undefined;

    let result: ExecResult;
    try {
      result = await pi.exec(
        "pnpm",
        [
          "exec",
          "biome",
          "check",
          "--write",
          "--no-errors-on-unmatched",
          file.relativePath,
        ],
        { cwd: file.root, signal: ctx.signal },
      );
    } catch (error) {
      result = {
        code: -1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
    if (result.code === 0) return undefined;

    const message = failureMessage(file.relativePath, result);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    return {
      content: [
        ...event.content,
        { type: "text", text: `\n${message}` } satisfies TextContent,
      ],
    };
  };
}

export default function biomeAfterWrite(pi: ExtensionAPI) {
  const handleMutation = createMutationHandler(pi);
  pi.on("tool_result", (event, ctx) => handleMutation(event, ctx));
}
