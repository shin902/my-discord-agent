import { describe, expect, it } from "vitest";

const CONFIG = { cookieFile: "data/reddit-cookies.json", maxAgeDays: 7 };

describe("getRedditCookieHeader", () => {


  it("クッキーファイルが存在しない場合エラーを投げる", async () => {
    const readCookieFile = async () => { throw new Error("ENOENT"); };
    const { getRedditCookieHeader, RedditCookieMissingError } = await import("./reddit-cookie-store.js");
    await expect(
      getRedditCookieHeader("reddit", CONFIG, readCookieFile),
    ).rejects.toBeInstanceOf(RedditCookieMissingError);
  });

  it("有効期限内のクッキーヘッダーを返す", async () => {
    const readCookieFile = async () => JSON.stringify({
          cookieHeader: "session=abc123; loid=xyz",
          updatedAt: new Date().toISOString(),
        });
    const { getRedditCookieHeader } = await import("./reddit-cookie-store.js");
    const header = await getRedditCookieHeader("reddit", CONFIG, readCookieFile);
    expect(header).toBe("session=abc123; loid=xyz");
  });

  it("maxAgeDays を超えている場合エラーを投げる", async () => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const readCookieFile = async () => JSON.stringify({
          cookieHeader: "session=abc123",
          updatedAt: staleDate.toISOString(),
        });
    const { getRedditCookieHeader, RedditCookieStaleError } = await import(
      "./reddit-cookie-store.js"
    );
    await expect(
      getRedditCookieHeader("reddit", CONFIG, readCookieFile),
    ).rejects.toBeInstanceOf(RedditCookieStaleError);
  });

  it("maxAgeDays ちょうど未満なら有効", async () => {
    const freshDate = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const readCookieFile = async () => JSON.stringify({
          cookieHeader: "session=abc123",
          updatedAt: freshDate.toISOString(),
        });
    const { getRedditCookieHeader } = await import("./reddit-cookie-store.js");
    await expect(getRedditCookieHeader("reddit", CONFIG, readCookieFile)).resolves.toBe(
      "session=abc123",
    );
  });
});
