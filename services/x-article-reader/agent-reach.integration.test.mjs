import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// agent-reach tool → Credential Proxy → mock x-article-reader の結合テスト。
// server.mjs はモジュールロード時に環境変数を読むため vi.resetModules() +
// vi.stubEnv() + 動的 import で分離する（services/x-article-reader/server.test.mjs
// と同じ方式）。credential-proxy-server.ts と agent-reach.ts は環境変数を
// リクエストごと/呼び出しごとに読むため通常の import でよい。

const READER_TOKEN = "reader-shared-secret-0123456789";

let readerServer;
let readerPort;
let proxyServer;
let proxyPort;
const originalEnv = { ...process.env };

async function startReader() {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("X_ARTICLE_READER_TOKEN", READER_TOKEN);
  vi.stubEnv("X_ARTICLE_READER_MOCK", "1");
  const mod = await import("./server.mjs");
  readerServer = mod.createXArticleReaderServer();
  await new Promise((resolve, reject) => {
    readerServer.on("error", reject);
    readerServer.listen(0, "127.0.0.1", resolve);
  });
  readerPort = readerServer.address().port;
}

async function startCredentialProxy() {
  const { createRequestHandler } = await import(
    "../../src/proxy/credential-proxy-server.js"
  );
  const creds = [
    {
      provider: "x-article",
      baseUrl: `http://127.0.0.1:${readerPort}`,
      envVars: ["X_ARTICLE_READER_TOKEN"],
      auth: { type: "bearer" },
    },
  ];
  proxyServer = http.createServer(createRequestHandler(creds, 5000));
  await new Promise((resolve, reject) => {
    proxyServer.on("error", reject);
    proxyServer.listen(0, "127.0.0.1", resolve);
  });
  proxyPort = proxyServer.address().port;
}

beforeEach(async () => {
  process.env = { ...originalEnv };
  await startReader();
  await startCredentialProxy();
  // credential-proxy-server.ts の handleRequest は process.env を
  // リクエストごとに読むため、reader の期待するトークンと同じ値を渡す。
  process.env.X_ARTICLE_READER_TOKEN = READER_TOKEN;
  // manager.ts が sandbox 側へ渡す CREDENTIAL_PROXY_JSON を模す。
  // sandbox 側には envVars/auth の値そのものは渡らない（baseUrl だけが渡る）。
  process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
    {
      provider: "x-article",
      baseUrl: `http://127.0.0.1:${proxyPort}/x-article`,
    },
  ]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  await Promise.all([
    new Promise((resolve) => readerServer?.close(resolve)),
    new Promise((resolve) => proxyServer?.close(resolve)),
  ]);
  readerServer = undefined;
  proxyServer = undefined;
});

describe("agent-reach → Credential Proxy → mock x-article-reader", () => {
  it("agentReachTool.execute() が Credential Proxy 経由で mock Article を取得する", async () => {
    // agentReachTool.execute() は最初に DNS 解決で private address check を行う。
    // このテストの関心事は Credential Proxy 経由の Article 取得経路であり、実際の
    // DNS 解決はネットワーク有無に左右されるため node:dns/promises をモックする。
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi
        .fn()
        .mockResolvedValue([{ address: "104.244.42.129", family: 4 }]),
    }));
    const { agentReachTool } = await import("../../src/tools/agent-reach.js");
    const result = await agentReachTool.execute(
      "call-1",
      { url: "https://x.com/i/article/123456789012345" },
      undefined,
    );

    const text = result.content[0].text;
    expect(text).toContain("信頼できない外部コンテンツ");
    expect(text).toContain("Mock X Article 123456789012345");
    expect(text).toContain("Mock plain text body for local integration tests.");
    expect(result.details.articleId).toBe("123456789012345");
    expect(result.details.service).toBe("x-article");
    expect(result.details.contentTruncated).toBe(false);
  });

  it("sandbox から誤った Bearer を送っても Credential Proxy が正しい token へ上書きする", async () => {
    const res = await fetch(
      `http://127.0.0.1:${proxyPort}/x-article/v1/article`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sandbox-sent-a-wrong-token",
        },
        body: JSON.stringify({ articleId: "42", format: "plain" }),
      },
    );
    expect(res.status).toBe(200);
    const article = await res.json();
    expect(article.articleId).toBe("42");
  });

  it("対比: reader へ直接誤った Bearer を送ると 401 になる", async () => {
    const res = await fetch(`http://127.0.0.1:${readerPort}/v1/article`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sandbox-sent-a-wrong-token",
      },
      body: JSON.stringify({ articleId: "42", format: "plain" }),
    });
    expect(res.status).toBe(401);
  });
});
