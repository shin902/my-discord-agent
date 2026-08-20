import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { RedditCookieConfig } from "../config/credential-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

const StoredCookiesSchema = z.object({ cookieHeader: z.string(), updatedAt: z.string() });

// reddit-cookie-refresh ジョブ（cron）が書き込み、credential-proxy が読み込む。
// Playwright の永続プロファイルから定期的に抽出した www.reddit.com 用クッキー。
export class RedditCookieStaleError extends Error {
  constructor(provider: string, ageDays: number, maxAgeDays: number) {
    super(
      `reddit cookie が期限切れです (provider: ${provider}, ${ageDays.toFixed(1)}日経過 > 上限${maxAgeDays}日)。reddit-cookie-refresh ジョブの実行状況を確認してください`,
    );
    this.name = "RedditCookieStaleError";
  }
}

export class RedditCookieMissingError extends Error {
  constructor(provider: string, cookieFile: string) {
    super(
      `reddit cookie ファイルが見つかりません (provider: ${provider}, path: ${cookieFile})。scripts/reddit-cookie-login.ts で初回ログインを行ってください`,
    );
    this.name = "RedditCookieMissingError";
  }
}

export async function getRedditCookieHeader(
  provider: string,
  config: RedditCookieConfig,
  readCookieFile: (path: string, encoding: "utf-8") => Promise<string> = readFile,
): Promise<string> {
  const cookieFile = path.resolve(ROOT, config.cookieFile);
  let raw: string;
  try {
    raw = await readCookieFile(cookieFile, "utf-8");
  } catch {
    throw new RedditCookieMissingError(provider, cookieFile);
  }

  const stored = StoredCookiesSchema.parse(JSON.parse(raw));
  const ageMs = Date.now() - new Date(stored.updatedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays > config.maxAgeDays) {
    throw new RedditCookieStaleError(provider, ageDays, config.maxAgeDays);
  }

  return stored.cookieHeader;
}
