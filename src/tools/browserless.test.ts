import { afterEach, describe, expect, it, vi } from "vitest";

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

describe("browserless tools", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("import 時に CREDENTIAL_PROXY_JSON を要求しない", async () => {
    vi.resetModules();
    const { CREDENTIAL_PROXY_JSON: _credentialProxyJson, ...env } =
      originalEnv;
    process.env = env;

    await expect(import("./browserless.js")).resolves.toBeTruthy();
  });

  it("実行時に browserless プロバイダーがなければ例外を投げる", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "graph", baseUrl: "http://proxy.test/graph" },
      ]),
    };

    const { browserlessSearchTool } = await import("./browserless.js");
    await expect(
      browserlessSearchTool.execute("id", { query: "test" }),
    ).rejects.toThrow(
      "browserless プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません",
    );
  });

  it("browserless プロキシへリクエストを送信する", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "browserless", baseUrl: "http://proxy.test/browserless/" },
      ]),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { browserlessSearchTool } = await import("./browserless.js");
    const result = await browserlessSearchTool.execute("id", {
      query: "テスト",
      limit: 3,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://proxy.test/browserless/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          query: "テスト",
          limit: 3,
          lang: "ja",
          sources: ["web"],
        }),
      }),
    );
    expect(firstText(result)).toContain('"ok": true');
  });
});
