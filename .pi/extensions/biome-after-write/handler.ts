import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

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

interface HandlerDependencies {
  exec(
    command: string,
    args: string[],
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<ExecResult>;
  withFileMutationQueue<T>(
    filePath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
}

function isInside(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

function normalizeToolPath(inputPath: string): string {
  return inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
}

async function repositoryFile(
  cwd: string,
  inputPath: unknown,
): Promise<
  { root: string; absolutePath: string; relativePath: string } | undefined
> {
  if (typeof inputPath !== "string" || inputPath.length === 0) return undefined;
  const normalizedPath = normalizeToolPath(inputPath);
  if (!BIOME_EXTENSIONS.has(extname(normalizedPath).toLowerCase())) {
    return undefined;
  }

  const [root, file] = await Promise.all([
    realpath(cwd),
    realpath(resolve(cwd, normalizedPath)),
  ]).catch(() => []);
  if (!root || !file || !isInside(root, file)) return undefined;
  if (!(await stat(file)).isFile()) return undefined;

  return { root, absolutePath: file, relativePath: relative(root, file) };
}

function failureMessage(path: string, result: ExecResult): string {
  const output = (result.stderr || result.stdout || "No output").trim();
  const suffix = output.length > MAX_ERROR_LENGTH ? "\n… (truncated)" : "";
  return `Biome failed for ${path} (exit ${result.code}):\n${output.slice(0, MAX_ERROR_LENGTH)}${suffix}`;
}

export function createMutationHandler(dependencies: HandlerDependencies) {
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
      result = await dependencies.withFileMutationQueue(
        file.absolutePath,
        async () =>
          dependencies.exec(
            "pnpm",
            [
              "exec",
              "biome",
              "check",
              "--write",
              "--no-errors-on-unmatched",
              "--",
              file.relativePath,
            ],
            { cwd: file.root, signal: ctx.signal },
          ),
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
