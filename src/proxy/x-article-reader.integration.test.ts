import type { Server } from "node:http";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestHandler } from "./credential-proxy-server.js";
import { createXArticleReaderServer } from "./x-article-reader.js";

const READER_TOKEN = "reader-shared-secret-0123456789";
const nativeFetch = globalThis.fetch;

let readerServer: Server | undefined;
let readerPort: number;
let proxyServer: Server | undefined;
let proxyPort: number;
const previousReaderToken = process.env.X_ARTICLE_READER_TOKEN;
const previousCredentialProxyJson = process.env.CREDENTIAL_PROXY_JSON;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address is unavailable");
  }
  return address.port;
}

async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeEach(async () => {
  readerServer = createXArticleReaderServer({
    token: READER_TOKEN,
    mock: true,
  });
  readerPort = await listen(readerServer);

  const creds = [
    {
      provider: "x-article",
      baseUrl: `http://127.0.0.1:${readerPort}`,
      envVars: ["X_ARTICLE_READER_TOKEN"],
      auth: { type: "bearer" as const },
    },
  ];
  proxyServer = http.createServer(createRequestHandler(creds, 5000));
  proxyPort = await listen(proxyServer);

  process.env.X_ARTICLE_READER_TOKEN = READER_TOKEN;
  process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
    {
      provider: "x-article",
      baseUrl: `http://127.0.0.1:${proxyPort}/x-article`,
    },
  ]);
});

afterEach(async () => {
  vi.doUnmock("node:dns/promises");
  vi.unstubAllGlobals();
  vi.resetModules();
  if (previousReaderToken === undefined)
    delete process.env.X_ARTICLE_READER_TOKEN;
  else process.env.X_ARTICLE_READER_TOKEN = previousReaderToken;
  if (previousCredentialProxyJson === undefined)
    delete process.env.CREDENTIAL_PROXY_JSON;
  else process.env.CREDENTIAL_PROXY_JSON = previousCredentialProxyJson;
  await Promise.all([close(readerServer), close(proxyServer)]);
  readerServer = undefined;
  proxyServer = undefined;
});

describe("agent-reach → Credential Proxy → mock x-article-reader", () => {
  it("agentReachTool.execute() が Credential Proxy 経由で mock Article を取得する", async () => {
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi
        .fn()
        .mockResolvedValue([{ address: "104.244.42.129", family: 4 }]),
    }));
    const { agentReachTool } = await import("../tools/agent-reach.js");
    const result = await agentReachTool.execute(
      "call-1",
      { url: "https://x.com/i/article/123456789012345" },
      undefined,
    );

    const firstContent = result.content[0];
    expect(firstContent.type).toBe("text");
    const text = firstContent.type === "text" ? firstContent.text : "";
    expect(text).toContain("信頼できない外部コンテンツ");
    expect(text).toContain("Mock X Article 123456789012345");
    expect(text).toContain("Mock plain text body for local integration tests.");
    expect(result.details.articleId).toBe("123456789012345");
    expect(result.details.service).toBe("x-article");
    expect(result.details.contentTruncated).toBe(false);
  });

  it("agentReachTool.execute() が Credential Proxy 経由で mock post を取得する", async () => {
    vi.resetModules();
    vi.doMock("node:dns/promises", () => ({
      lookup: vi
        .fn()
        .mockResolvedValue([{ address: "104.244.42.129", family: 4 }]),
    }));
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const requestUrl = input instanceof Request ? input.url : String(input);
        if (requestUrl.startsWith("https://api.fxtwitter.com/")) {
          return new Response(JSON.stringify({ message: "stubbed" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          });
        }
        return nativeFetch(input, init);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { agentReachTool } = await import("../tools/agent-reach.js");
    const result = await agentReachTool.execute(
      "call-2",
      { url: "https://x.com/mock_reader/status/123456789012345?s=20" },
      undefined,
    );

    const firstContent = result.content[0];
    expect(firstContent.type).toBe("text");
    const text = firstContent.type === "text" ? firstContent.text : "";
    expect(text).toContain("信頼できない外部コンテンツ");
    expect(text).toContain("Mock X post text for local integration tests.");
    expect(result.details.postId).toBe("123456789012345");
    expect(result.details.service).toBe("x-twitter");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.fxtwitter.com/mock_reader/status/123456789012345",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
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
    const article = (await res.json()) as { articleId: string };
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
