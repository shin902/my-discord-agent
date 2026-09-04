import "dotenv/config";
import { fileURLToPath } from "node:url";
import { refreshRedditCookiesInRuntime } from "../src/runtime/reddit-cookie-refresh-client.js";

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown error";
  const token = process.env.AGENT_REACH_REFRESH_TOKEN;
  return token ? message.replaceAll(token, "[redacted]") : message;
}

/** Run the host-only Reddit cookie maintenance operation once. */
export async function main(): Promise<void> {
  try {
    await refreshRedditCookiesInRuntime();
    console.log("[reddit-cookie-refresh] reddit.com クッキーを更新しました");
  } catch (error) {
    console.error(
      `[reddit-cookie-refresh] クッキー更新に失敗しました: ${formatError(error)}`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
