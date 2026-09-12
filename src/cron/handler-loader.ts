import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NonRetryableError } from "../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function resolveHandlerPath(handlerRelPath: string): string {
  if (/\.\.(\/|\\|$)/.test(handlerRelPath)) {
    throw new NonRetryableError(`不正なハンドラーパス: ${handlerRelPath}`);
  }
  // tsx (dev): .ts そのまま / tsc (prod): .ts → .js
  const runnerExt = path.extname(new URL(import.meta.url).pathname);
  const resolvedPath =
    runnerExt === ".ts"
      ? handlerRelPath
      : handlerRelPath.replace(/\.ts$/, ".js");
  const absPath = path.resolve(__dirname, resolvedPath);
  if (!absPath.startsWith(ROOT + path.sep)) {
    throw new NonRetryableError(
      `ハンドラーパスがプロジェクト外を参照しています: ${handlerRelPath}`,
    );
  }
  return absPath;
}

export async function loadHandlerFn(
  handlerRelPath: string,
): Promise<(context: unknown) => Promise<void>> {
  const absPath = resolveHandlerPath(handlerRelPath);
  const mod = (await import(pathToFileURL(absPath).href)) as {
    default?: (context: unknown) => Promise<void>;
  };
  if (typeof mod.default !== "function") {
    throw new NonRetryableError(
      `ハンドラー ${handlerRelPath} に default export (function) がありません`,
    );
  }
  return mod.default;
}

/** Compare loader-resolved handlers, including relative and runtime extension aliases. */
export async function isCronHandler(
  job: { handler?: string },
  handler: string,
): Promise<boolean> {
  if (job.handler === undefined) return false;
  return (await loadHandlerFn(job.handler)) === (await loadHandlerFn(handler));
}
