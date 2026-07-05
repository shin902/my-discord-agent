import type { Server } from "node:http";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRequestHandler } from "./credential-proxy-server.js";
import { createXArticleReaderServer } from "./x-article-reader.js";

const READER_TOKEN = "reader-shared-secret-0123456789";

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

describe("Credential Proxy → mock x-article-reader", () => {
  it("Credential Proxy 経由で mock Article を取得する", async () => {
    const res = await fetch(
      `http://127.0.0.1:${proxyPort}/x-article/v1/article`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ articleId: "123456789012345", format: "plain" }),
      },
    );
    expect(res.status).toBe(200);
    const article = (await res.json()) as {
      articleId: string;
      title: string;
      plainText: string;
      contentTruncated: boolean;
    };
    expect(article.articleId).toBe("123456789012345");
    expect(article.title).toContain("Mock X Article 123456789012345");
    expect(article.plainText).toContain(
      "Mock plain text body for local integration tests.",
    );
    expect(article.contentTruncated).toBe(false);
  });

  it("Credential Proxy 経由で mock post を取得する", async () => {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/x-article/v1/post`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postId: "123456789012345" }),
    });
    expect(res.status).toBe(200);
    const post = (await res.json()) as { postId: string; text: string };
    expect(post.postId).toBe("123456789012345");
    expect(post.text).toContain(
      "Mock X post text for local integration tests.",
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
