import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PROFILE_DIR = path.join(ROOT, "data/reddit-browser-profile");

// 初回セットアップ専用。モニターが接続された実機で実行し、表示されたブラウザで
// 捨て垢に手動ログインする。以降の延命・クッキー再取得は
// Tool Runtime の reddit-cookie-refresh cron maintenance が定期的に行う。
async function main() {
  console.log(`プロファイル保存先: ${PROFILE_DIR}`);
  console.log("ブラウザが起動します。reddit.com に手動でログインしてください。");
  console.log("ログイン完了後、このブラウザウィンドウを閉じてください。");

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
  });
  const page = await context.newPage();
  await page.goto("https://www.reddit.com/login");

  await new Promise<void>((resolve) => {
    context.on("close", () => resolve());
  });

  console.log("プロファイルを保存しました。pnpm cron か手動で reddit-cookie-refresh ジョブを実行して動作確認してください。");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
