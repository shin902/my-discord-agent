import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "./config.js";

let loader: ReturnType<typeof vi.fn<() => Promise<JsonValue | string>>>;

beforeEach(() => {
  loader = vi.fn<() => Promise<JsonValue | string>>();
});

function makeConfig(credentials: JsonValue[]): JsonValue {
  return JSON.parse(JSON.stringify(credentials));
}

async function importFresh() {
  vi.resetModules();
  const mod = await import("./credential-proxy.js");
  return mod;
}

describe("loadCredentialProxy", () => {
  it("設定ファイルを読み込んでパースする", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(
      makeConfig([
        {
          provider: "openai",
          envVars: ["OPENAI_API_KEY"],
          baseUrl: "https://api.example.com",
        },
      ]),
    );

    const result = await loadCredentialProxy(loader);
    expect(result).toEqual([
      {
        provider: "openai",
        envVars: ["OPENAI_API_KEY"],
        baseUrl: "https://api.example.com",
      },
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("2回目以降の呼び出しではキャッシュを返し readFile を呼ばない", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(
      makeConfig([
        {
          provider: "openai",
          envVars: ["OPENAI_API_KEY"],
          baseUrl: "https://api.example.com",
        },
      ]),
    );

    await loadCredentialProxy(loader);
    const result = await loadCredentialProxy(loader);
    expect(result).toEqual([
      {
        provider: "openai",
        envVars: ["OPENAI_API_KEY"],
        baseUrl: "https://api.example.com",
      },
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("credentials が配列でない場合はエラーをスローする", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(JSON.stringify({ foo: "bar" }));

    await expect(loadCredentialProxy(loader)).rejects.toThrow();
  });

  it("ファイルが存在しない場合はエラーをスローする", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    await expect(loadCredentialProxy(loader)).rejects.toThrow("ENOENT");
  });

  it("ENOENT 以外のエラーは再スロー", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockRejectedValue(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
    );

    await expect(loadCredentialProxy(loader)).rejects.toThrow("EACCES");
  });

  it("不正な JSON は SyntaxError を投げる", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue("{ invalid json }");

    await expect(loadCredentialProxy(loader)).rejects.toThrow(SyntaxError);
  });

  it("credentials のスキーマに合わない JSON は ZodError を投げる", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(
      makeConfig([
        {
          provider: "openai",
          envVars: ["OPENAI_API_KEY"],
          baseUrl: "not-a-url",
        },
      ]),
    );

    await expect(loadCredentialProxy(loader)).rejects.toThrow();
  });

  it("廃止された thinkingFormat: 'qwen' は移行先を示すエラーメッセージで弾かれる", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(
      makeConfig([
        {
          provider: "llama-cpp",
          baseUrl: "http://localhost:8080/v1",
          compat: { thinkingFormat: "qwen" },
        },
      ]),
    );

    await expect(loadCredentialProxy(loader)).rejects.toThrow(
      /qwen-chat-template.*openrouter/,
    );
  });

  it("CLIProxyAPI 向け openai-codex-responses 設定を受け付ける", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(
      makeConfig([
        {
          provider: "codex-oauth",
          forceCustom: true,
          envVars: ["CLIPROXY_API_KEY"],
          baseUrl: "http://localhost:8317/v1",
          api: "openai-codex-responses",
          contextWindow: 192000,
          maxTokens: 8192,
        },
      ]),
    );

    const result = await loadCredentialProxy(loader);
    expect(result).toEqual([
      {
        provider: "codex-oauth",
        forceCustom: true,
        envVars: ["CLIPROXY_API_KEY"],
        baseUrl: "http://localhost:8317/v1",
        api: "openai-codex-responses",
        contextWindow: 192000,
        maxTokens: 8192,
      },
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("credentials が空配列も正常にキャッシュされる", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(makeConfig([]));

    const result1 = await loadCredentialProxy(loader);
    expect(result1).toEqual([]);

    const result2 = await loadCredentialProxy(loader);
    expect(result2).toEqual([]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("ollama 向け thinkingFormat: openrouter と thinkingLevelMap を受け付ける", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(
      makeConfig([
        {
          provider: "ollama",
          baseUrl: "http://localhost:11434/v1",
          compat: {
            thinkingFormat: "openrouter",
            thinkingLevelMap: { off: "none", minimal: "low", xhigh: "high" },
          },
        },
      ]),
    );

    const result = await loadCredentialProxy(loader);
    expect(result).toEqual([
      {
        provider: "ollama",
        baseUrl: "http://localhost:11434/v1",
        compat: {
          thinkingFormat: "openrouter",
          thinkingLevelMap: { off: "none", minimal: "low", xhigh: "high" },
        },
      },
    ]);
  });

  it("query-token 認証設定を受け付ける", async () => {
    const { loadCredentialProxy } = await importFresh();
    loader.mockResolvedValue(
      makeConfig([
        {
          provider: "browserless",
          envVars: ["BROWSERLESS_TOKEN"],
          auth: { type: "query-token", queryParam: "token" },
          baseUrl: "https://production-sfo.browserless.io",
        },
      ]),
    );

    const result = await loadCredentialProxy(loader);
    expect(result).toEqual([
      {
        provider: "browserless",
        envVars: ["BROWSERLESS_TOKEN"],
        auth: { type: "query-token", queryParam: "token" },
        baseUrl: "https://production-sfo.browserless.io",
      },
    ]);
  });
});
