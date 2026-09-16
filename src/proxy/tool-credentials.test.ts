import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";
import { initToolCredentials } from "./tool-credentials.js";

const mocks = vi.hoisted(() => ({
  loadCredentialProxy: vi.fn(),
  initGraphAuth: vi.fn(),
  initGoogleAuth: vi.fn(),
  getGoogleAccessToken: vi.fn(),
}));

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: mocks.loadCredentialProxy,
}));
vi.mock("./graph-auth.js", () => ({ initGraphAuth: mocks.initGraphAuth }));
vi.mock("./google-auth.js", () => ({
  initGoogleAuth: mocks.initGoogleAuth,
  getGoogleAccessToken: mocks.getGoogleAccessToken,
  GoogleAuthRequiredError: class GoogleAuthRequiredError extends Error {},
}));

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

  let credentialEntries: CredentialEntry[];

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    credentialEntries = GOOGLE_CREDS;
    mocks.loadCredentialProxy.mockImplementation(async () => credentialEntries);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("initializes Graph independently of the Credential Proxy server", async () => {
    const msal = {
      tenantId: "tenant",
      clientId: "client",
      scopes: ["Mail.Read"],
    };
    credentialEntries = [
      {
        provider: "graph",
        baseUrl: "https://graph.microsoft.com/v1.0",
        msal,
      },
    ];
    await initToolCredentials();
    expect(mocks.initGraphAuth).toHaveBeenCalledWith("graph", msal);
  });

  it("clientSecretEnvVar が未設定のとき Google Auth をスキップして警告する", async () => {
    delete process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await initToolCredentials();

    expect(mocks.initGoogleAuth).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_CALENDAR_CLIENT_SECRET"),
    );
    warnSpy.mockRestore();
  });

  it("clientSecretEnvVar が設定済みのとき initGoogleAuth を呼ぶ", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    await initToolCredentials();

    expect(mocks.initGoogleAuth).toHaveBeenCalledWith(
      "google-calendar",
      GOOGLE_CREDS[0]?.google,
      "test-secret",
    );
  });

  it("起動時に getGoogleAccessToken を呼んでデバイスコードフローを済ませておく", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    mocks.getGoogleAccessToken.mockResolvedValue("token");

    await initToolCredentials();

    expect(mocks.getGoogleAccessToken).toHaveBeenCalledWith("google-calendar");
  });

  it("getGoogleAccessToken が失敗してもサーバー起動は継続する", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    mocks.getGoogleAccessToken.mockRejectedValue(
      new Error("device flow timeout"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await initToolCredentials();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("device flow timeout"),
    );
    errorSpy.mockRestore();
  });
});
