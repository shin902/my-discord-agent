import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: async () => [
    {
      provider: "graph",
      baseUrl: "https://graph.fixture.test/v1.0",
      msal: {
        tenantId: "tenant",
        clientId: "client",
        scopes: ["Mail.ReadWrite"],
      },
    },
  ],
}));
vi.mock("../config/proxy-config.js", () => ({
  loadRequestTimeoutMs: async () => 30000,
}));
const getGraphAccessToken = vi.hoisted(() => vi.fn());
vi.mock("../proxy/graph-auth.js", () => ({ getGraphAccessToken }));

import { acknowledgeEmail } from "./mail-ack.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("mail ACK host credential boundary", () => {
  it("PATCHes Graph directly with host OAuth without initializing Credential Proxy", async () => {
    getGraphAccessToken.mockResolvedValue("host-graph-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await acknowledgeEmail("mail/id?fragment#");
    expect(getGraphAccessToken).toHaveBeenCalledWith("graph");
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://graph.fixture.test/v1.0/me/messages/mail%2Fid%3Ffragment%23",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer host-graph-token",
        },
        body: JSON.stringify({ isRead: true }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("propagates a rejected PATCH so delivery does not report a successful ACK", async () => {
    getGraphAccessToken.mockResolvedValue("host-graph-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );
    await expect(acknowledgeEmail("mail-1")).rejects.toThrow(
      "メール既読化失敗: 503",
    );
  });

  it("does not send an unauthenticated PATCH when Graph token acquisition fails", async () => {
    getGraphAccessToken.mockRejectedValue(new Error("OAuth unavailable"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(acknowledgeEmail("mail-1")).rejects.toThrow(
      "メール既読化失敗: 502",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
