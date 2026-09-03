import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { getGoogleAccessToken } from "../proxy/google-auth.js";
import { getGraphAccessToken } from "../proxy/graph-auth.js";
import { hostFetch } from "./host-fetch.js";

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn(),
}));
vi.mock("../config/proxy-config.js", () => ({
  loadRequestTimeoutMs: vi.fn().mockResolvedValue(120_000),
}));
vi.mock("../proxy/google-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../proxy/google-auth.js")>()),
  getGoogleAccessToken: vi.fn(),
}));
vi.mock("../proxy/graph-auth.js", () => ({ getGraphAccessToken: vi.fn() }));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("hostFetch", () => {
  it("env credentialをhostでBearerとして注入する", async () => {
    process.env.HOST_API_TOKEN = "host-secret";
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "api",
        envVars: ["HOST_API_TOKEN"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await hostFetch("api", "/items");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/items",
      expect.objectContaining({
        headers: { Authorization: "Bearer host-secret" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("GraphとGoogleの既存OAuth token取得経路を再利用する", async () => {
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "graph",
        baseUrl: "https://graph.microsoft.com/v1.0",
        msal: { tenantId: "t", clientId: "c", scopes: ["s"] },
      },
      {
        provider: "google-calendar",
        baseUrl: "https://www.googleapis.com/calendar/v3",
        google: { clientId: "c", clientSecretEnvVar: "SECRET", scopes: ["s"] },
      },
    ]);
    vi.mocked(getGraphAccessToken).mockResolvedValue("graph-token");
    vi.mocked(getGoogleAccessToken).mockResolvedValue("google-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await hostFetch("graph", "/me");
    await hostFetch("google-calendar", "/users/me/calendarList");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
      "Bearer graph-token",
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
      "Bearer google-token",
    );
  });

  it("proxy.requestTimeoutMs相当のtimeoutを504 responseとして維持する", async () => {
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      { provider: "api", baseUrl: "https://api.example.com" },
    ]);
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort());
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    const response = await hostFetch("api", "/items");
    expect(response.status).toBe(504);
    expect(await response.text()).toBe("Gateway Timeout");
  });
});
