import { refreshXCookiesInRuntime } from "../../runtime/tool-runtime-client.js";
import type { CronContext } from "../runner.js";

export default async function handler(_context: CronContext): Promise<void> {
  try {
    await refreshXCookiesInRuntime();
    console.log("[x-cookie-refresh] X cookies refreshed");
  } catch (error) {
    console.error(
      `[x-cookie-refresh] Refresh failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}
