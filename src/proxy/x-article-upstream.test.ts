import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchXArticleFromGraphql,
  XArticleUpstreamError,
} from "./x-article-upstream.js";

type FetchCall = { url: string; init?: RequestInit };

const FIXED_NOW_ISO = "2026-07-01T00:00:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);

let tmpDir: string;
let cookieFile: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "x-article-upstream-test-"));
  cookieFile = join(tmpDir, "x-cookies.json");
  await writeFile(
    cookieFile,
    JSON.stringify({
      cookieHeader: "auth_token=super-secret; ct0=csrf-secret",
      csrfToken: "csrf-secret",
      updatedAt: FIXED_NOW_ISO,
    }),
    "utf-8",
  );
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createMockFetch(responses: Response[]): {
  calls: FetchCall[];
  fetchImpl: (url: string | URL, init?: RequestInit) => Promise<Response>;
} {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: url.toString(), init });
    const response = responses.shift();
    if (!response) throw new Error("unexpected fetch call");
    return response;
  });
  return { calls, fetchImpl };
}

function redirectBody(tweetId = "1987654321098765432") {
  return {
    data: {
      article_result_by_rest_id: {
        result: {
          metadata: {
            tweet_results: { rest_id: tweetId },
          },
        },
      },
    },
  };
}

function tweetBody() {
  return {
    data: {
      tweetResult: {
        result: {
          core: {
            user_results: {
              result: {
                legacy: {
                  name: "Example Author",
                  screen_name: "example",
                },
              },
            },
          },
          legacy: {
            created_at: "Wed Jul 01 00:00:00 +0000 2026",
          },
          article: {
            article_results: {
              result: {
                rest_id: "123456789012345",
                title: "Real X Article",
                preview_text: "Article preview",
                plain_text: "Article body",
                cover_media: {
                  media_info: {
                    original_img_url: "https://pbs.twimg.com/cover.jpg",
                  },
                },
                media_entities: [
                  {
                    media_info: {
                      original_img_url: "https://pbs.twimg.com/body.jpg",
                    },
                  },
                  { media_info: {} },
                ],
                lifecycle_state: "PUBLISHED",
              },
            },
          },
        },
      },
    },
  };
}

describe("fetchXArticleFromGraphql", () => {
  it("data/x-cookies.json の Cookie/CSRF を使い、2 hop GraphQL で Article を正規化する", async () => {
    const { calls, fetchImpl } = createMockFetch([
      jsonResponse(redirectBody()),
      jsonResponse(tweetBody()),
    ]);

    const article = await fetchXArticleFromGraphql("123456789012345", {
      cookieFile,
      graphqlBaseUrl: "https://x.example/i/api/graphql",
      fetchImpl,
      nowMs: FIXED_NOW_MS,
    });

    expect(article).toEqual({
      postId: "1987654321098765432",
      canonicalUrl: "https://x.com/i/article/123456789012345",
      title: "Real X Article",
      author: { name: "Example Author", username: "example" },
      previewText: "Article preview",
      plainText: "Article body",
      media: [
        { url: "https://pbs.twimg.com/cover.jpg" },
        { url: "https://pbs.twimg.com/body.jpg" },
      ],
      publishedAt: "2026-07-01T00:00:00.000Z",
      contentTruncated: false,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain(
      "/zrSRXJmE1vj37AUmkh2oGg/ArticleRedirectScreenQuery",
    );
    expect(calls[1].url).toContain(
      "/Xl5pC_lBk_gcO2ItU39DQw/TweetResultByRestId",
    );

    const redirectUrl = new URL(calls[0].url);
    expect(
      JSON.parse(redirectUrl.searchParams.get("variables") ?? "{}"),
    ).toEqual({
      articleEntityId: "123456789012345",
    });
    expect(
      JSON.parse(redirectUrl.searchParams.get("features") ?? "null"),
    ).toEqual({});

    const tweetUrl = new URL(calls[1].url);
    expect(JSON.parse(tweetUrl.searchParams.get("variables") ?? "{}")).toEqual({
      tweetId: "1987654321098765432",
      withCommunity: false,
      includePromotedContent: false,
      withVoice: false,
    });
    expect(
      JSON.parse(tweetUrl.searchParams.get("fieldToggles") ?? "{}"),
    ).toEqual({
      withArticleRichContentState: true,
      withArticlePlainText: true,
      withGrokAnalyze: false,
    });

    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.cookie).toBe("auth_token=super-secret; ct0=csrf-secret");
    expect(headers["x-csrf-token"]).toBe("csrf-secret");
    expect(headers.authorization).toMatch(/^Bearer /);
  });

  it("cookie ファイルがない場合は AUTH_EXPIRED に変換する", async () => {
    await expect(
      fetchXArticleFromGraphql("123", {
        cookieFile: join(tmpDir, "missing.json"),
        fetchImpl: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("upstream 429 は RATE_LIMITED に変換する", async () => {
    const { fetchImpl } = createMockFetch([
      jsonResponse({ error: "rate" }, 429),
    ]);

    await expect(
      fetchXArticleFromGraphql("123", {
        cookieFile,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
  });

  it("redirect response の shape が変わったら UPSTREAM_CHANGED", async () => {
    const { fetchImpl } = createMockFetch([jsonResponse({ data: {} })]);

    await expect(
      fetchXArticleFromGraphql("123", {
        cookieFile,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_CHANGED" });
  });

  it("redirect できても tweet id が空なら ARTICLE_NOT_FOUND", async () => {
    const { fetchImpl } = createMockFetch([
      jsonResponse({ data: { article_result_by_rest_id: { result: {} } } }),
    ]);

    await expect(
      fetchXArticleFromGraphql("123", {
        cookieFile,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      }),
    ).rejects.toMatchObject({ code: "ARTICLE_NOT_FOUND" });
  });

  it("TweetResult に article payload がなければ ARTICLE_NOT_FOUND", async () => {
    const { fetchImpl } = createMockFetch([
      jsonResponse(redirectBody()),
      jsonResponse({ data: { tweetResult: { result: {} } } }),
    ]);

    await expect(
      fetchXArticleFromGraphql("123", {
        cookieFile,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      }),
    ).rejects.toMatchObject({ code: "ARTICLE_NOT_FOUND" });
  });

  it("upstream timeout は UPSTREAM_TIMEOUT に変換する", async () => {
    const fetchImpl = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    );

    await expect(
      fetchXArticleFromGraphql("123", {
        cookieFile,
        fetchImpl,
        timeoutMs: 1,
        nowMs: FIXED_NOW_MS,
      }),
    ).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", retryable: true });
  });

  it("upstream error に Cookie/CSRF を含めない", async () => {
    const { fetchImpl } = createMockFetch([
      jsonResponse({ error: "secret" }, 401),
    ]);

    try {
      await fetchXArticleFromGraphql("123", {
        cookieFile,
        fetchImpl,
        nowMs: FIXED_NOW_MS,
      });
      throw new Error("expected failure");
    } catch (err) {
      expect(err).toBeInstanceOf(XArticleUpstreamError);
      const text = String(err);
      expect(text).not.toContain("super-secret");
      expect(text).not.toContain("csrf-secret");
    }
  });
});
