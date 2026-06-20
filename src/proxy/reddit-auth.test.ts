import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REDDIT_CONFIG = {
  clientId: "test-client-id",
  clientSecretEnvVar: "REDDIT_CLIENT_SECRET",
};
const CLIENT_SECRET = "test-client-secret";

describe("getRedditAccessToken", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("initRedditAuth を呼ばずに呼び出すとエラーを投げる", async () => {
    const { getRedditAccessToken } = await import("./reddit-auth.js");
    await expect(getRedditAccessToken("reddit")).rejects.toThrow(
      "Reddit Auth が初期化されていません",
    );
  });

  it("client_credentials グラントでアクセストークンを取得する", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        access_token: "access-token-1",
        expires_in: 3600,
      }),
    });

    const { initRedditAuth, getRedditAccessToken } = await import(
      "./reddit-auth.js"
    );
    await initRedditAuth("reddit", REDDIT_CONFIG, CLIENT_SECRET);
    const token = await getRedditAccessToken("reddit");

    expect(token).toBe("access-token-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://www.reddit.com/api/v1/access_token");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from(`${REDDIT_CONFIG.clientId}:${CLIENT_SECRET}`).toString("base64")}`,
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("有効なキャッシュ済みトークンを再利用し fetch を呼ばない", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        access_token: "access-token-1",
        expires_in: 3600,
      }),
    });

    const { initRedditAuth, getRedditAccessToken } = await import(
      "./reddit-auth.js"
    );
    await initRedditAuth("reddit", REDDIT_CONFIG, CLIENT_SECRET);
    const token1 = await getRedditAccessToken("reddit");
    const token2 = await getRedditAccessToken("reddit");

    expect(token1).toBe("access-token-1");
    expect(token2).toBe("access-token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("期限切れのキャッシュは再取得する", async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          access_token: "access-token-1",
          // EXPIRY_MARGIN_MS(60秒)未満ですぐ失効扱いになる
          expires_in: 1,
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          access_token: "access-token-2",
          expires_in: 3600,
        }),
      });

    const { initRedditAuth, getRedditAccessToken } = await import(
      "./reddit-auth.js"
    );
    await initRedditAuth("reddit", REDDIT_CONFIG, CLIENT_SECRET);
    const token1 = await getRedditAccessToken("reddit");
    const token2 = await getRedditAccessToken("reddit");

    expect(token1).toBe("access-token-1");
    expect(token2).toBe("access-token-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("access_token が返らない場合はエラーを投げる", async () => {
    fetchMock.mockResolvedValue({
      status: 401,
      json: async () => ({ error: "invalid_client" }),
    });

    const { initRedditAuth, getRedditAccessToken } = await import(
      "./reddit-auth.js"
    );
    await initRedditAuth("reddit", REDDIT_CONFIG, CLIENT_SECRET);

    await expect(getRedditAccessToken("reddit")).rejects.toThrow(
      "Reddit access token 取得失敗",
    );
  });

  it("プロバイダーごとに独立してトークンを管理する", async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "token-a", expires_in: 3600 }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ access_token: "token-b", expires_in: 3600 }),
      });

    const { initRedditAuth, getRedditAccessToken } = await import(
      "./reddit-auth.js"
    );
    await initRedditAuth("reddit-a", REDDIT_CONFIG, CLIENT_SECRET);
    await initRedditAuth("reddit-b", REDDIT_CONFIG, "other-secret");

    expect(await getRedditAccessToken("reddit-a")).toBe("token-a");
    expect(await getRedditAccessToken("reddit-b")).toBe("token-b");
  });
});
