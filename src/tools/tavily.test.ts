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

describe("tavily search tool", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("import 時に CREDENTIAL_PROXY_JSON を要求しない", async () => {
    vi.resetModules();
    const { CREDENTIAL_PROXY_JSON: _credentialProxyJson, ...env } = originalEnv;
    process.env = env;

    await expect(import("./tavily.js")).resolves.toBeTruthy();
  });

  it("実行時に tavily プロバイダーがなければ例外を投げる", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "graph", baseUrl: "http://proxy.test/graph" },
      ]),
    };

    const { tavilySearchTool } = await import("./tavily.js");
    await expect(
      tavilySearchTool.execute("id", { query: "test" }),
    ).rejects.toThrow(
      "tavily プロバイダーが credentials.json に見つかりません",
    );
  });

  it("host APIへBearer認証付きで検索リクエストを送信する", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: "tavily-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        answer: "テスト回答",
        results: [
          {
            title: "テスト結果",
            url: "https://example.com",
            content: "テスト内容",
            score: 0.95,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tavilySearchTool } = await import("./tavily.js");
    const result = await tavilySearchTool.execute("id", { query: "テスト" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer tavily-secret",
        },
        body: JSON.stringify({
          query: "テスト",
          max_results: 5,
          search_depth: "basic",
          include_answer: true,
          topic: "general",
        }),
      }),
    );
    const text = firstText(result);
    expect(text).toContain("テスト回答");
    expect(text).toContain("テスト結果");
    expect(text).toContain("https://example.com");
    expect(text).toContain("0.95");
  });

  it("結果が空のとき '(結果なし)' を返す", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: "tavily-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [] }),
      }),
    );

    const { tavilySearchTool } = await import("./tavily.js");
    const result = await tavilySearchTool.execute("id", { query: "nothing" });

    expect(firstText(result)).toContain("(結果なし)");
  });

  it("entry.envVars を順番に見て最初に設定されたキーを使う", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: undefined,
      TAVILY_ALIAS_KEY: "alias-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_MISSING_KEY", "TAVILY_ALIAS_KEY", "TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tavilySearchTool } = await import("./tavily.js");
    await tavilySearchTool.execute("id", { query: "alias" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer alias-secret",
        }),
      }),
    );
  });

  it("proxy.requestTimeoutMs で upstream fetch を timeout し、abort reason を旧 proxy と同じ意味にする", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: "tavily-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    vi.doMock("../config/proxy-config.js", () => ({
      loadRequestTimeoutMs: vi.fn().mockResolvedValue(25),
    }));
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { tavilySearchTool } = await import("./tavily.js");
      const request = tavilySearchTool.execute("id", { query: "timeout" });
      await vi.advanceTimersByTimeAsync(25);
      await expect(request).rejects.toThrow("upstream timeout for tavily");
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.tavily.com/search",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("results が undefined でもクラッシュしない", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: "tavily-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      }),
    );

    const { tavilySearchTool } = await import("./tavily.js");
    const result = await tavilySearchTool.execute("id", { query: "test" });

    expect(firstText(result)).toContain("(結果なし)");
  });

  it("API エラー時に例外を投げる", async () => {
    process.env = {
      ...originalEnv,
      TAVILY_API_KEY: "tavily-secret",
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        {
          provider: "tavily",
          envVars: ["TAVILY_API_KEY"],
          baseUrl: "https://api.tavily.com",
        },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => "Rate limit exceeded",
      }),
    );

    const { tavilySearchTool } = await import("./tavily.js");
    await expect(
      tavilySearchTool.execute("id", { query: "test" }),
    ).rejects.toThrow("Tavily API エラー 429");
  });
});

describe("tavily extract tool", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("tavily プロキシへ抽出リクエストを送信する", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "tavily", baseUrl: "http://proxy.test/tavily/" },
      ]),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ url: "https://example.com", raw_content: "本文テキスト" }],
        failed_results: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tavilyExtractTool } = await import("./tavily.js");
    const result = await tavilyExtractTool.execute("id", {
      urls: ["https://example.com"],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://proxy.test/tavily/extract",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          urls: ["https://example.com"],
          extract_depth: "basic",
          include_images: false,
        }),
      }),
    );
    const text = firstText(result);
    expect(text).toContain("https://example.com");
    expect(text).toContain("本文テキスト");
  });

  it("失敗したURLは失敗理由とともに表示する", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "tavily", baseUrl: "http://proxy.test/tavily" },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [],
          failed_results: [{ url: "https://broken.example", error: "timeout" }],
        }),
      }),
    );

    const { tavilyExtractTool } = await import("./tavily.js");
    const result = await tavilyExtractTool.execute("id", {
      urls: ["https://broken.example"],
    });

    const text = firstText(result);
    expect(text).toContain("https://broken.example");
    expect(text).toContain("timeout");
  });

  it("API エラー時に例外を投げる", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "tavily", baseUrl: "http://proxy.test/tavily" },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      }),
    );

    const { tavilyExtractTool } = await import("./tavily.js");
    await expect(
      tavilyExtractTool.execute("id", { urls: ["https://example.com"] }),
    ).rejects.toThrow("Tavily API エラー 500");
  });
});

describe("tavily crawl tool", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("tavily プロキシへクロールリクエストを送信する", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "tavily", baseUrl: "http://proxy.test/tavily/" },
      ]),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        base_url: "https://example.com",
        results: [
          { url: "https://example.com/a", raw_content: "ページAの本文" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tavilyCrawlTool } = await import("./tavily.js");
    const result = await tavilyCrawlTool.execute("id", {
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://proxy.test/tavily/crawl",
      expect.objectContaining({ method: "POST" }),
    );
    const text = firstText(result);
    expect(text).toContain("https://example.com/a");
    expect(text).toContain("ページAの本文");
  });

  it("結果が空のとき '(結果なし)' を返す", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "tavily", baseUrl: "http://proxy.test/tavily" },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ base_url: "https://example.com", results: [] }),
      }),
    );

    const { tavilyCrawlTool } = await import("./tavily.js");
    const result = await tavilyCrawlTool.execute("id", {
      url: "https://example.com",
    });

    expect(firstText(result)).toContain("(結果なし)");
  });
});

describe("tavily map tool", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("tavily プロキシへマッピングリクエストを送信する", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "tavily", baseUrl: "http://proxy.test/tavily/" },
      ]),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        base_url: "https://example.com",
        results: ["https://example.com/a", "https://example.com/b"],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { tavilyMapTool } = await import("./tavily.js");
    const result = await tavilyMapTool.execute("id", {
      url: "https://example.com",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://proxy.test/tavily/map",
      expect.objectContaining({ method: "POST" }),
    );
    const text = firstText(result);
    expect(text).toContain("https://example.com/a");
    expect(text).toContain("https://example.com/b");
  });

  it("結果が空のとき '(結果なし)' を返す", async () => {
    process.env = {
      ...originalEnv,
      CREDENTIAL_PROXY_JSON: JSON.stringify([
        { provider: "tavily", baseUrl: "http://proxy.test/tavily" },
      ]),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ base_url: "https://example.com", results: [] }),
      }),
    );

    const { tavilyMapTool } = await import("./tavily.js");
    const result = await tavilyMapTool.execute("id", {
      url: "https://example.com",
    });

    expect(firstText(result)).toContain("(結果なし)");
  });
});
