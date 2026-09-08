import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RedditCookieConfig } from "../config/credential-proxy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

type StoredCookies = {
  cookieHeader: string;
  updatedAt: string;
};

// Tool Runtime の Reddit fetch が読み込む状態。cron maintenance が
// Playwright の永続プロファイルから定期的に抽出した www.reddit.com 用クッキーを書き込む。
export class RedditCookieStaleError extends Error {
  constructor(provider: string, ageDays: number, maxAgeDays: number) {
    super(
      `reddit cookie が期限切れです (provider: ${provider}, ${ageDays.toFixed(1)}日経過 > 上限${maxAgeDays}日)。reddit-cookie-refresh ジョブの実行状況を確認してください`,
    );
    this.name = "RedditCookieStaleError";
  }
}

export class RedditCookieMissingError extends Error {
  constructor(provider: string, _cookieFile: string) {
    super(
      `reddit cookie ファイルが見つかりません (provider: ${provider})。scripts/reddit-cookie-login.ts で初回ログインを行ってください`,
    );
    this.name = "RedditCookieMissingError";
  }
}

export class RedditCookieInvalidError extends Error {
  constructor(provider: string) {
    super(
      `reddit cookie の状態が不正です (provider: ${provider})。reddit-cookie-refresh を実行してください`,
    );
    this.name = "RedditCookieInvalidError";
  }
}

export async function getRedditCookieHeader(
  provider: string,
  config: RedditCookieConfig,
): Promise<string> {
  const cookieFile = path.isAbsolute(config.cookieFile)
    ? config.cookieFile
    : path.resolve(ROOT, config.cookieFile);
  let raw: string;
  try {
    raw = await readFile(cookieFile, "utf-8");
  } catch {
    throw new RedditCookieMissingError(provider, cookieFile);
  }

  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    throw new RedditCookieInvalidError(provider);
  }
  if (
    typeof stored !== "object" ||
    stored === null ||
    typeof (stored as Partial<StoredCookies>).cookieHeader !== "string" ||
    typeof (stored as Partial<StoredCookies>).updatedAt !== "string" ||
    !Number.isFinite(
      Date.parse(String((stored as Partial<StoredCookies>).updatedAt)),
    )
  ) {
    throw new RedditCookieInvalidError(provider);
  }
  const typedStored = stored as StoredCookies;
  const updatedAt = typedStored.updatedAt;
  if (typedStored.cookieHeader.trim() === "") {
    if (updatedAt === "1970-01-01T00:00:00.000Z") {
      throw new RedditCookieMissingError(provider, cookieFile);
    }
    throw new RedditCookieInvalidError(provider);
  }
  const ageMs = Date.now() - new Date(updatedAt).getTime();
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  if (ageDays > config.maxAgeDays) {
    throw new RedditCookieStaleError(provider, ageDays, config.maxAgeDays);
  }

  return typedStored.cookieHeader;
}
