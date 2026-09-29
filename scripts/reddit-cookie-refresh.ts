import "dotenv/config";
import { fileURLToPath } from "node:url";
import { refreshRedditCookies } from "../src/proxy/reddit-cookie-refresh.js";

/** Refresh Reddit cookies on the host. */
export async function main(): Promise<void> {
  try {
    await refreshRedditCookies();
    console.log("[reddit-cookie-refresh] reddit.com クッキーを更新しました");
  } catch {
    console.error("[reddit-cookie-refresh] クッキー更新に失敗しました。pnpm reddit:login を確認してください");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
