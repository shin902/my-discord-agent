import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createXArticleReaderServer } from "./x-article-reader.js";

const TOKEN = "test-token-0123456789";

let server: Server | undefined;
let baseUrl: string;
let tmpDir: string | undefined;

async function startServer(
  options: { token?: string; mock?: boolean; fixturePath?: string } = {},
) {
  server = createXArticleReaderServer({ token: TOKEN, ...options });
  await new Promise<void>((resolve, reject) => {
    server?.on("error", reject);
    server?.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server address is unavailable");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

function postArticle(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/v1/article`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("認証", () => {
  it("Authorization ヘッダがないと 401 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle({ articleId: "123", format: "plain" });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("INVALID_REQUEST");
  });

  it("Bearer token が一致しないと 401 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "123", format: "plain" },
      { authorization: "Bearer wrong-token" },
    );
    expect(res.status).toBe(401);
  });

  it("token が未設定のときは常に 401 を返す", async () => {
    await startServer({ token: "", mock: true });
    const res = await postArticle(
      { articleId: "123", format: "plain" },
      { authorization: "Bearer anything" },
    );
    expect(res.status).toBe(401);
  });
});

describe("routing", () => {
  it("GET /healthz は 200 を返す", async () => {
    await startServer({ mock: true });
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("POST /v1/article 以外の path は 404 を返す", async () => {
    await startServer({ mock: true });
    const res = await fetch(`${baseUrl}/v1/other`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(404);
  });

  it("/v1/article への GET は 405 を返す", async () => {
    await startServer({ mock: true });
    const res = await fetch(`${baseUrl}/v1/article`, {
      method: "GET",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
  });
});

describe("request 検証", () => {
  it("Content-Type が application/json でないと 415 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      JSON.stringify({ articleId: "123", format: "plain" }),
      { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain" },
    );
    expect(res.status).toBe(415);
  });

  it("body が 4 KiB を超えると 413 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "123", format: "plain", padding: "x".repeat(5 * 1024) },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(413);
  });

  it("articleId が非数値だと 400 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "not-a-number", format: "plain" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(400);
  });

  it("articleId が33桁以上だと 400 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "1".repeat(33), format: "plain" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(400);
  });

  it("articleId が欠落していると 400 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { format: "plain" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(400);
  });

  it("format が preview/plain 以外だと 400 を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "123", format: "full" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(400);
  });
});

describe("mock モード", () => {
  it("正常な Article JSON を返す", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "123456789", format: "plain" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    const article = (await res.json()) as Record<string, unknown>;
    expect(article.articleId).toBe("123456789");
    expect(article.source).toBe("x-internal-graphql");
    expect(article.canonicalUrl).toBe("https://x.com/i/article/123456789");
    expect(article.title).toContain("123456789");
    expect(typeof article.plainText).toBe("string");
    expect(article.contentTruncated).toBe(false);
  });

  it("format=preview では plainText を含まない", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "123456789", format: "preview" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    const article = (await res.json()) as Record<string, unknown>;
    expect(article.plainText).toBeUndefined();
    expect(typeof article.previewText).toBe("string");
  });
});

describe("fixture モード", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "x-article-reader-test-"));
  });

  it("plainText が 120,000 文字超なら切り詰めて contentTruncated: true を返す", async () => {
    if (!tmpDir) throw new Error("tmpDir is missing");
    const fixturePath = join(tmpDir, `fixture-${randomUUID()}.json`);
    await writeFile(
      fixturePath,
      JSON.stringify({
        articleId: "999",
        canonicalUrl: "https://x.com/i/article/999",
        title: "Long Article",
        plainText: "a".repeat(130_000),
      }),
    );
    await startServer({ fixturePath });
    const res = await postArticle(
      { articleId: "999", format: "plain" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(200);
    const article = (await res.json()) as {
      plainText: string;
      contentTruncated: boolean;
    };
    expect(article.plainText.length).toBe(120_000);
    expect(article.contentTruncated).toBe(true);
  });
});

describe("upstream 未設定", () => {
  it("mock も fixture もないと UPSTREAM_CHANGED を返す", async () => {
    await startServer();
    const res = await postArticle(
      { articleId: "123", format: "plain" },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("UPSTREAM_CHANGED");
  });
});

describe("エラーレスポンスの安全性", () => {
  it("エラー response に X Cookie や生 header が含まれない", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "not-a-number", format: "plain" },
      {
        authorization: `Bearer ${TOKEN}`,
        cookie: "auth_token=super-secret-x-cookie; ct0=csrf-secret",
      },
    );
    const text = await res.text();
    expect(text).not.toContain("super-secret-x-cookie");
    expect(text).not.toContain("csrf-secret");
    expect(text).not.toContain("cookie");
    expect(text).not.toContain("authorization");
    const json = JSON.parse(text);
    expect(Object.keys(json)).toEqual(["error"]);
    expect(Object.keys(json.error).sort()).toEqual([
      "code",
      "message",
      "retryable",
    ]);
  });

  it("401 response に token 情報が含まれない", async () => {
    await startServer({ mock: true });
    const res = await postArticle(
      { articleId: "123", format: "plain" },
      { authorization: "Bearer wrong-token" },
    );
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("wrong-token");
  });
});
