import "dotenv/config";
import { fileURLToPath } from "node:url";
import { refreshXCookiesInRuntime } from "../src/runtime/tool-runtime-client.js";

export async function main(): Promise<void> {
  try {
    await refreshXCookiesInRuntime();
    console.log("[x-cookie-refresh] X cookies refreshed");
  } catch (error) {
    console.error(
      `[x-cookie-refresh] Refresh failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
