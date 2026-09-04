import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CONFIG = { cookieFile: "data/reddit-cookies.json", maxAgeDays: 7 };

describe("getRedditCookieHeader", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("クッキーファイルが存在しない場合エラーを投げる", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    }));
    const { getRedditCookieHeader, RedditCookieMissingError } = await import(
      "./reddit-cookie-store.js"
    );
    await expect(
      getRedditCookieHeader("reddit", CONFIG),
    ).rejects.toBeInstanceOf(RedditCookieMissingError);
  });

  it("空の初期化プレースホルダーは未設定として扱う", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          cookieHeader: "",
          updatedAt: "1970-01-01T00:00:00.000Z",
        }),
      ),
    }));
    const { getRedditCookieHeader, RedditCookieMissingError } = await import(
      "./reddit-cookie-store.js"
    );
    await expect(
      getRedditCookieHeader("reddit", CONFIG),
    ).rejects.toBeInstanceOf(RedditCookieMissingError);
  });

  it("有効期限内のクッキーヘッダーを返す", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          cookieHeader: "session=abc123; loid=xyz",
          updatedAt: new Date().toISOString(),
        }),
      ),
    }));
    const { getRedditCookieHeader } = await import("./reddit-cookie-store.js");
    const header = await getRedditCookieHeader("reddit", CONFIG);
    expect(header).toBe("session=abc123; loid=xyz");
  });

  it("maxAgeDays を超えている場合エラーを投げる", async () => {
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          cookieHeader: "session=abc123",
          updatedAt: staleDate.toISOString(),
        }),
      ),
    }));
    const { getRedditCookieHeader, RedditCookieStaleError } = await import(
      "./reddit-cookie-store.js"
    );
    await expect(
      getRedditCookieHeader("reddit", CONFIG),
    ).rejects.toBeInstanceOf(RedditCookieStaleError);
  });

  it("maxAgeDays ちょうど未満なら有効", async () => {
    const freshDate = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          cookieHeader: "session=abc123",
          updatedAt: freshDate.toISOString(),
        }),
      ),
    }));
    const { getRedditCookieHeader } = await import("./reddit-cookie-store.js");
    await expect(getRedditCookieHeader("reddit", CONFIG)).resolves.toBe(
      "session=abc123",
    );
  });
});
