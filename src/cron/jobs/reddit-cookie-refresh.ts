import { refreshRedditCookiesInRuntime } from "../../runtime/reddit-cookie-refresh-client.js";
import type { CronContext } from "../runner.js";

export default async function handler(_ctx: CronContext): Promise<void> {
  try {
    await refreshRedditCookiesInRuntime();
    console.log("[reddit-cookie-refresh] reddit.com クッキーを更新しました");
  } catch (err) {
    console.error(
      `[reddit-cookie-refresh] クッキー更新に失敗しました: ${err instanceof Error ? err.message : err}`,
    );
  }
}
