import "dotenv/config";
import { fileURLToPath } from "node:url";
import { refreshRedditCookiesInRuntime } from "../src/runtime/tool-runtime-client.js";

/** Run the host-only Reddit cookie maintenance operation once. */
export async function main(): Promise<void> {
  try {
    await refreshRedditCookiesInRuntime();
    console.log("[reddit-cookie-refresh] reddit.com クッキーを更新しました");
  } catch (error) {
    console.error(
      `[reddit-cookie-refresh] クッキー更新に失敗しました: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
