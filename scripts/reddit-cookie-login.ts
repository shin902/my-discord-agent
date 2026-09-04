import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ensureRedditCookieFile } from "../src/proxy/reddit-cookie-file.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PROFILE_DIR = path.join(ROOT, "data/reddit-browser-profile");
const COOKIE_FILE = path.join(ROOT, "data/reddit-cookies.json");

// 初回セットアップ専用。モニターが接続された実機で実行し、表示されたブラウザで
// 捨て垢に手動ログインする。以降の延命・クッキー再取得は
// Tool Runtime の reddit-cookie-refresh cron maintenance が定期的に行う。
export async function main(): Promise<void> {
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

  await ensureRedditCookieFile(COOKIE_FILE);
  console.log("プロファイルを保存しました。pnpm cron か手動で reddit-cookie-refresh ジョブを実行して動作確認してください。");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
