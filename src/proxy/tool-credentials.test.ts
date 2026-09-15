import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";

describe("initToolCredentials: host integration initialization", () => {
  const originalEnv = process.env;
  const GOOGLE_CREDS: CredentialEntry[] = [
    {
      provider: "google-calendar",
      baseUrl: "https://www.googleapis.com/calendar/v3",
      google: {
        clientId: "test-client-id",
        clientSecretEnvVar: "GOOGLE_CALENDAR_CLIENT_SECRET",
        scopes: ["https://www.googleapis.com/auth/calendar"],
      },
    },
  ];

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue(GOOGLE_CREDS),
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  it("initializes Graph independently of the Credential Proxy server", async () => {
    const msal = {
      tenantId: "tenant",
      clientId: "client",
      scopes: ["Mail.Read"],
    };
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "graph",
          baseUrl: "https://graph.microsoft.com/v1.0",
          msal,
        },
      ]),
    }));
    const initGraphAuth = vi.fn();
    vi.doMock("./graph-auth.js", () => ({ initGraphAuth }));
    const { initToolCredentials } = await import("./tool-credentials.js");
    await initToolCredentials();
    expect(initGraphAuth).toHaveBeenCalledWith("graph", msal);
  });

  it("clientSecretEnvVar が未設定のとき Google Auth をスキップして警告する", async () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const initGoogleAuth = vi.fn();
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth,
      getGoogleAccessToken: vi.fn(),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { initToolCredentials } = await import("./tool-credentials.js");
    await initToolCredentials();

    expect(initGoogleAuth).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_CALENDAR_CLIENT_SECRET"),
    );
    warnSpy.mockRestore();
  });

  it("clientSecretEnvVar が設定済みのとき initGoogleAuth を呼ぶ", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    const initGoogleAuth = vi.fn();
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth,
      getGoogleAccessToken: vi.fn(),
    }));

    const { initToolCredentials } = await import("./tool-credentials.js");
    await initToolCredentials();

    expect(initGoogleAuth).toHaveBeenCalledWith(
      "google-calendar",
      GOOGLE_CREDS[0]?.google,
      "test-secret",
    );
  });

  it("起動時に getGoogleAccessToken を呼んでデバイスコードフローを済ませておく", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    const getGoogleAccessToken = vi.fn().mockResolvedValue("token");
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth: vi.fn(),
      getGoogleAccessToken,
    }));

    const { initToolCredentials } = await import("./tool-credentials.js");
    await initToolCredentials();

    expect(getGoogleAccessToken).toHaveBeenCalledWith("google-calendar");
  });

  it("getGoogleAccessToken が失敗してもサーバー起動は継続する", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    const getGoogleAccessToken = vi
      .fn()
      .mockRejectedValue(new Error("device flow timeout"));
    vi.doMock("./google-auth.js", () => ({
      initGoogleAuth: vi.fn(),
      getGoogleAccessToken,
      GoogleAuthRequiredError: class GoogleAuthRequiredError extends Error {},
    }));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { initToolCredentials } = await import("./tool-credentials.js");
    await initToolCredentials();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("device flow timeout"),
    );
    errorSpy.mockRestore();
  });
});
