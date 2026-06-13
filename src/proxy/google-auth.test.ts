import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GOOGLE_CONFIG = {
  clientId: "test-client-id",
  clientSecretEnvVar: "GOOGLE_CALENDAR_CLIENT_SECRET",
  scopes: ["https://www.googleapis.com/auth/calendar"],
};
const CLIENT_SECRET = "test-client-secret";

describe("getGoogleAccessToken", () => {
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

  it("initGoogleAuth を呼ばずに呼び出すとエラーを投げる", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      chmod: vi.fn(),
    }));
    const { getGoogleAccessToken } = await import("./google-auth.js");
    await expect(getGoogleAccessToken("google-calendar")).rejects.toThrow(
      "Google Auth が初期化されていません",
    );
  });

  it("キャッシュされた有効なアクセストークンを再利用する", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          accessToken: "cached-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 60 * 60 * 1000,
        }),
      ),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
      chmod: vi.fn(),
    }));
    const { initGoogleAuth, getGoogleAccessToken } = await import(
      "./google-auth.js"
    );
    await initGoogleAuth("google-calendar", GOOGLE_CONFIG, CLIENT_SECRET);
    const token = await getGoogleAccessToken("google-calendar");

    expect(token).toBe("cached-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("期限切れのとき refresh_token でアクセストークンを再取得する", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockResolvedValue(
        JSON.stringify({
          accessToken: "expired-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() - 1000,
        }),
      ),
      writeFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }));
    fetchMock.mockResolvedValue({
      json: async () => ({
        access_token: "refreshed-token",
        expires_in: 3600,
      }),
    });

    const { initGoogleAuth, getGoogleAccessToken } = await import(
      "./google-auth.js"
    );
    await initGoogleAuth("google-calendar", GOOGLE_CONFIG, CLIENT_SECRET);
    const token = await getGoogleAccessToken("google-calendar");

    expect(token).toBe("refreshed-token");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token");
    expect(body.get("client_secret")).toBe(CLIENT_SECRET);
    expect(writeFile).toHaveBeenCalled();
  });

  it("キャッシュなし → デバイスコードフローでトークンを取得する", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }));
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          device_code: "device-code-123",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 1800,
          interval: 0,
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          access_token: "device-access-token",
          refresh_token: "device-refresh-token",
          expires_in: 3600,
        }),
      });

    const { initGoogleAuth, getGoogleAccessToken } = await import(
      "./google-auth.js"
    );
    await initGoogleAuth("google-calendar", GOOGLE_CONFIG, CLIENT_SECRET);
    const token = await getGoogleAccessToken("google-calendar");

    expect(token).toBe("device-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://oauth2.googleapis.com/device/code",
    );
    expect(writeFile).toHaveBeenCalled();
    const persisted = JSON.parse(writeFile.mock.calls[0][1] as string);
    expect(persisted.refreshToken).toBe("device-refresh-token");
  });

  it("デバイスコードフローが authorization_pending を返した後成功する", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }));
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          device_code: "device-code-123",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 1800,
          interval: 0,
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({ error: "authorization_pending" }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          access_token: "device-access-token",
          expires_in: 3600,
        }),
      });

    const { initGoogleAuth, getGoogleAccessToken } = await import(
      "./google-auth.js"
    );
    await initGoogleAuth("google-calendar", GOOGLE_CONFIG, CLIENT_SECRET);
    const token = await getGoogleAccessToken("google-calendar");

    expect(token).toBe("device-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("デバイスコードフローが access_denied 等のエラーを返したら例外を投げる", async () => {
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
      chmod: vi.fn().mockResolvedValue(undefined),
    }));
    fetchMock
      .mockResolvedValueOnce({
        json: async () => ({
          device_code: "device-code-123",
          user_code: "ABCD-EFGH",
          verification_url: "https://www.google.com/device",
          expires_in: 1800,
          interval: 0,
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          error: "access_denied",
          error_description: "User denied access",
        }),
      });

    const { initGoogleAuth, getGoogleAccessToken } = await import(
      "./google-auth.js"
    );
    await initGoogleAuth("google-calendar", GOOGLE_CONFIG, CLIENT_SECRET);
    await expect(getGoogleAccessToken("google-calendar")).rejects.toThrow(
      "access_denied",
    );
  });
});
