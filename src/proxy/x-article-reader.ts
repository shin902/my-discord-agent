import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import {
  fetchXArticleFromGraphql,
  fetchXPostFromGraphql,
  XArticleUpstreamError,
  type XArticleUpstreamOptions,
} from "./x-article-upstream.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PREVIEW_CHARS = 10_000;
const MAX_PLAIN_CHARS = 120_000;
const MAX_MEDIA = 100;

const READER_ERROR_CODES = [
  "INVALID_REQUEST",
  "ARTICLE_NOT_FOUND",
  "AUTH_EXPIRED",
  "RATE_LIMITED",
  "UPSTREAM_CHANGED",
  "UPSTREAM_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;

type ReaderErrorCode = (typeof READER_ERROR_CODES)[number];

type RawArticle = {
  postId?: unknown;
  canonicalUrl?: unknown;
  title?: unknown;
  author?: unknown;
  previewText?: unknown;
  plainText?: unknown;
  media?: unknown;
  publishedAt?: unknown;
  contentTruncated?: unknown;
};

type RawPost = {
  postId?: unknown;
  canonicalUrl?: unknown;
  author?: unknown;
  text?: unknown;
  media?: unknown;
  publishedAt?: unknown;
  contentTruncated?: unknown;
};

type NormalizedArticle = {
  articleId: string;
  postId?: string;
  canonicalUrl: string;
  title?: string;
  author?: {
    name?: string;
    username?: string;
  };
  previewText?: string;
  plainText?: string;
  media: Array<{ url: string; alt?: string }>;
  publishedAt?: string;
  source: "x-internal-graphql";
  contentTruncated: boolean;
};

type NormalizedPost = {
  postId: string;
  canonicalUrl: string;
  author?: {
    name?: string;
    username?: string;
  };
  text: string;
  media: Array<{ url: string; alt?: string }>;
  publishedAt?: string;
  source: "x-internal-graphql";
  contentTruncated: boolean;
};

export type XArticleReaderOptions = {
  token?: string;
  mock?: boolean;
  fixturePath?: string;
  cookieFile?: string;
  maxCookieAgeDays?: number;
  graphqlBaseUrl?: string;
  articleRedirectQueryId?: string;
  tweetResultQueryId?: string;
  bearerToken?: string;
  upstreamTimeoutMs?: number;
  upstreamFetchImpl?: XArticleUpstreamOptions["fetchImpl"];
  nowMs?: number;
};

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(expectedToken: string, actualBearer: string): boolean {
  if (!expectedToken || !actualBearer) return false;
  return timingSafeEqual(sha256(actualBearer), sha256(expectedToken));
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendReaderError(
  res: ServerResponse,
  status: number,
  code: ReaderErrorCode,
  message: string,
  retryable = false,
): void {
  sendJson(res, status, { error: { code, message, retryable } });
}

function enforceResponseSize(value: unknown): void {
  const encoded = Buffer.from(JSON.stringify(value));
  if (encoded.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
}

async function readLimitedBody(req: IncomingMessage): Promise<string> {
  const contentLength = req.headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function truncateText(
  value: unknown,
  maxChars: number,
): { value?: string; truncated: boolean } {
  if (typeof value !== "string") return { truncated: false };
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function safeReaderMessage(code: ReaderErrorCode): string {
  switch (code) {
    case "ARTICLE_NOT_FOUND":
      return "The requested X Article was not found.";
    case "AUTH_EXPIRED":
      return "The host-side X session has expired.";
    case "RATE_LIMITED":
      return "The X Article reader is rate limited.";
    case "UPSTREAM_TIMEOUT":
      return "The X Article upstream request timed out.";
    case "RESPONSE_TOO_LARGE":
      return "Reader response is too large.";
    case "UPSTREAM_CHANGED":
      return "Upstream response shape changed.";
    case "INVALID_REQUEST":
      return "Invalid reader request.";
    case "INTERNAL_ERROR":
      return "Internal reader error.";
  }
}

function normalizeMedia(input: unknown): Array<{ url: string; alt?: string }> {
  return Array.isArray(input)
    ? input
        .filter(
          (m): m is Record<string, unknown> =>
            isObject(m) && typeof m.url === "string",
        )
        .slice(0, MAX_MEDIA)
        .map((m) => ({
          url: m.url as string,
          ...(typeof m.alt === "string" ? { alt: m.alt.slice(0, 2000) } : {}),
        }))
    : [];
}

function normalizeAuthor(
  input: unknown,
): { name?: string; username?: string } | undefined {
  return isObject(input)
    ? {
        ...(typeof input.name === "string"
          ? { name: input.name.slice(0, 200) }
          : {}),
        ...(typeof input.username === "string"
          ? { username: input.username.slice(0, 64) }
          : {}),
      }
    : undefined;
}

export function normalizeXArticle(
  input: unknown,
  articleId: string,
): NormalizedArticle {
  if (!isObject(input)) {
    throw new Error("UPSTREAM_CHANGED");
  }

  const raw = input as RawArticle;
  const preview = truncateText(raw.previewText, MAX_PREVIEW_CHARS);
  const plain = truncateText(raw.plainText, MAX_PLAIN_CHARS);
  const media = normalizeMedia(raw.media);
  const author = normalizeAuthor(raw.author);

  const article: NormalizedArticle = {
    articleId,
    ...(typeof raw.postId === "string" && /^\d{1,32}$/.test(raw.postId)
      ? { postId: raw.postId }
      : {}),
    canonicalUrl:
      typeof raw.canonicalUrl === "string"
        ? raw.canonicalUrl
        : `https://x.com/i/article/${articleId}`,
    ...(typeof raw.title === "string"
      ? { title: raw.title.slice(0, 500) }
      : {}),
    ...(author && Object.keys(author).length > 0 ? { author } : {}),
    ...(preview.value !== undefined ? { previewText: preview.value } : {}),
    ...(plain.value !== undefined ? { plainText: plain.value } : {}),
    media,
    ...(typeof raw.publishedAt === "string"
      ? { publishedAt: raw.publishedAt }
      : {}),
    source: "x-internal-graphql",
    contentTruncated:
      Boolean(raw.contentTruncated) || preview.truncated || plain.truncated,
  };

  return article;
}

export function normalizeXPost(input: unknown, postId: string): NormalizedPost {
  if (!isObject(input)) {
    throw new Error("UPSTREAM_CHANGED");
  }

  const raw = input as RawPost;
  const text = truncateText(raw.text, MAX_PLAIN_CHARS);
  if (text.value === undefined) {
    throw new Error("UPSTREAM_CHANGED");
  }
  const author = normalizeAuthor(raw.author);
  const post: NormalizedPost = {
    postId,
    canonicalUrl:
      typeof raw.canonicalUrl === "string"
        ? raw.canonicalUrl
        : `https://x.com/i/status/${postId}`,
    ...(author && Object.keys(author).length > 0 ? { author } : {}),
    text: text.value,
    media: normalizeMedia(raw.media),
    ...(typeof raw.publishedAt === "string"
      ? { publishedAt: raw.publishedAt }
      : {}),
    source: "x-internal-graphql",
    contentTruncated: Boolean(raw.contentTruncated) || text.truncated,
  };

  enforceResponseSize(post);
  return post;
}

async function loadArticle(
  articleId: string,
  options: Required<Pick<XArticleReaderOptions, "mock">> &
    Omit<XArticleReaderOptions, "mock">,
): Promise<NormalizedArticle> {
  if (options.mock) {
    return normalizeXArticle(
      {
        postId: "1",
        canonicalUrl: `https://x.com/i/article/${articleId}`,
        title: `Mock X Article ${articleId}`,
        author: { name: "Mock Reader", username: "mock_reader" },
        previewText: "Mock preview text.",
        plainText: "Mock plain text body for local integration tests.",
        media: [],
        publishedAt: "2026-07-01T00:00:00Z",
      },
      articleId,
    );
  }

  if (options.fixturePath) {
    const raw = JSON.parse(await readFile(options.fixturePath, "utf8"));
    const candidate =
      isObject(raw) && isObject(raw.articles) ? raw.articles[articleId] : raw;
    return normalizeXArticle(candidate, articleId);
  }

  const upstream = await fetchXArticleFromGraphql(articleId, {
    cookieFile: options.cookieFile,
    maxCookieAgeDays: options.maxCookieAgeDays,
    graphqlBaseUrl: options.graphqlBaseUrl,
    articleRedirectQueryId: options.articleRedirectQueryId,
    tweetResultQueryId: options.tweetResultQueryId,
    bearerToken: options.bearerToken,
    timeoutMs: options.upstreamTimeoutMs,
    fetchImpl: options.upstreamFetchImpl,
    nowMs: options.nowMs,
  });
  return normalizeXArticle(upstream, articleId);
}

async function loadPost(
  postId: string,
  options: Required<Pick<XArticleReaderOptions, "mock">> &
    Omit<XArticleReaderOptions, "mock">,
): Promise<NormalizedPost> {
  if (options.mock) {
    return normalizeXPost(
      {
        postId,
        canonicalUrl: `https://x.com/mock_reader/status/${postId}`,
        author: { name: "Mock Reader", username: "mock_reader" },
        text: "Mock X post text for local integration tests.",
        media: [],
        publishedAt: "2026-07-01T00:00:00Z",
      },
      postId,
    );
  }

  if (options.fixturePath) {
    const raw = JSON.parse(await readFile(options.fixturePath, "utf8"));
    const candidate =
      isObject(raw) && isObject(raw.posts) ? raw.posts[postId] : raw;
    return normalizeXPost(candidate, postId);
  }

  const upstream = await fetchXPostFromGraphql(postId, {
    cookieFile: options.cookieFile,
    maxCookieAgeDays: options.maxCookieAgeDays,
    graphqlBaseUrl: options.graphqlBaseUrl,
    tweetResultQueryId: options.tweetResultQueryId,
    bearerToken: options.bearerToken,
    timeoutMs: options.upstreamTimeoutMs,
    fetchImpl: options.upstreamFetchImpl,
    nowMs: options.nowMs,
  });
  return normalizeXPost(upstream, postId);
}

async function handleArticle(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<XArticleReaderOptions, "token" | "mock">> &
    Omit<XArticleReaderOptions, "token" | "mock">,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const bearer =
    typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length)
      : "";
  if (!tokenMatches(options.token, bearer)) {
    sendReaderError(res, 401, "INVALID_REQUEST", "Invalid reader token.");
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    sendReaderError(
      res,
      415,
      "INVALID_REQUEST",
      "Content-Type must be application/json.",
    );
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readLimitedBody(req));
  } catch (err) {
    if (err instanceof Error && err.message === "REQUEST_TOO_LARGE") {
      sendReaderError(
        res,
        413,
        "INVALID_REQUEST",
        "Request body is too large.",
      );
      return;
    }
    sendReaderError(res, 400, "INVALID_REQUEST", "Request JSON is invalid.");
    return;
  }

  const articleId = isObject(body) ? body.articleId : undefined;
  const format = isObject(body) ? body.format : undefined;
  if (typeof articleId !== "string" || !/^\d{1,32}$/.test(articleId)) {
    sendReaderError(
      res,
      400,
      "INVALID_REQUEST",
      "articleId must be 1-32 digits.",
    );
    return;
  }
  if (format !== "preview" && format !== "plain") {
    sendReaderError(
      res,
      400,
      "INVALID_REQUEST",
      "format must be preview or plain.",
    );
    return;
  }

  try {
    const article = { ...(await loadArticle(articleId, options)) };
    if (format === "preview") delete article.plainText;
    enforceResponseSize(article);
    sendJson(res, 200, article);
  } catch (err) {
    if (err instanceof XArticleUpstreamError) {
      const status =
        err.code === "AUTH_EXPIRED"
          ? 401
          : err.code === "RATE_LIMITED"
            ? 429
            : err.code === "ARTICLE_NOT_FOUND"
              ? 404
              : 502;
      sendReaderError(
        res,
        status,
        err.code,
        safeReaderMessage(err.code),
        err.retryable,
      );
      return;
    }

    const code = err instanceof Error ? err.message : "INTERNAL_ERROR";
    if (code === "RESPONSE_TOO_LARGE") {
      sendReaderError(
        res,
        502,
        "RESPONSE_TOO_LARGE",
        "Reader response is too large.",
      );
    } else if (code === "UPSTREAM_CHANGED") {
      sendReaderError(
        res,
        502,
        "UPSTREAM_CHANGED",
        "Upstream response shape changed.",
      );
    } else {
      console.error("[x-article-reader] internal error");
      sendReaderError(res, 500, "INTERNAL_ERROR", "Internal reader error.");
    }
  }
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  options: Required<Pick<XArticleReaderOptions, "token" | "mock">> &
    Omit<XArticleReaderOptions, "token" | "mock">,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const bearer =
    typeof auth === "string" && auth.startsWith("Bearer ")
      ? auth.slice("Bearer ".length)
      : "";
  if (!tokenMatches(options.token, bearer)) {
    sendReaderError(res, 401, "INVALID_REQUEST", "Invalid reader token.");
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    sendReaderError(
      res,
      415,
      "INVALID_REQUEST",
      "Content-Type must be application/json.",
    );
    return;
  }

  let body: unknown;
  try {
    body = JSON.parse(await readLimitedBody(req));
  } catch (err) {
    if (err instanceof Error && err.message === "REQUEST_TOO_LARGE") {
      sendReaderError(
        res,
        413,
        "INVALID_REQUEST",
        "Request body is too large.",
      );
      return;
    }
    sendReaderError(res, 400, "INVALID_REQUEST", "Request JSON is invalid.");
    return;
  }

  const postId = isObject(body) ? body.postId : undefined;
  if (typeof postId !== "string" || !/^\d{1,32}$/.test(postId)) {
    sendReaderError(res, 400, "INVALID_REQUEST", "postId must be 1-32 digits.");
    return;
  }

  try {
    sendJson(res, 200, await loadPost(postId, options));
  } catch (err) {
    if (err instanceof XArticleUpstreamError) {
      const status =
        err.code === "AUTH_EXPIRED"
          ? 401
          : err.code === "RATE_LIMITED"
            ? 429
            : err.code === "ARTICLE_NOT_FOUND"
              ? 404
              : 502;
      sendReaderError(
        res,
        status,
        err.code,
        safeReaderMessage(err.code),
        err.retryable,
      );
      return;
    }

    const code = err instanceof Error ? err.message : "INTERNAL_ERROR";
    if (code === "RESPONSE_TOO_LARGE") {
      sendReaderError(
        res,
        502,
        "RESPONSE_TOO_LARGE",
        "Reader response is too large.",
      );
    } else if (code === "UPSTREAM_CHANGED") {
      sendReaderError(
        res,
        502,
        "UPSTREAM_CHANGED",
        "Upstream response shape changed.",
      );
    } else {
      console.error("[x-article-reader] internal error");
      sendReaderError(res, 500, "INTERNAL_ERROR", "Internal reader error.");
    }
  }
}

export function createXArticleReaderRequestHandler(
  options: XArticleReaderOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const resolved = {
    token: options.token ?? process.env.X_ARTICLE_READER_TOKEN ?? "",
    mock: options.mock ?? process.env.X_ARTICLE_READER_MOCK === "1",
    fixturePath: options.fixturePath ?? process.env.X_ARTICLE_READER_FIXTURE,
    cookieFile:
      options.cookieFile ??
      process.env.X_ARTICLE_COOKIE_FILE ??
      process.env.X_COOKIE_FILE,
    maxCookieAgeDays:
      options.maxCookieAgeDays ??
      (process.env.X_ARTICLE_COOKIE_MAX_AGE_DAYS
        ? Number(process.env.X_ARTICLE_COOKIE_MAX_AGE_DAYS)
        : undefined),
    graphqlBaseUrl:
      options.graphqlBaseUrl ?? process.env.X_ARTICLE_GRAPHQL_BASE_URL,
    articleRedirectQueryId:
      options.articleRedirectQueryId ?? process.env.X_ARTICLE_REDIRECT_QUERY_ID,
    tweetResultQueryId:
      options.tweetResultQueryId ?? process.env.X_ARTICLE_TWEET_RESULT_QUERY_ID,
    bearerToken: options.bearerToken ?? process.env.X_WEB_BEARER_TOKEN,
    upstreamTimeoutMs:
      options.upstreamTimeoutMs ??
      (process.env.X_ARTICLE_UPSTREAM_TIMEOUT_MS
        ? Number(process.env.X_ARTICLE_UPSTREAM_TIMEOUT_MS)
        : undefined),
    upstreamFetchImpl: options.upstreamFetchImpl,
    nowMs: options.nowMs,
  };

  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    const route = url.pathname;
    if (route !== "/v1/article" && route !== "/v1/post") {
      sendJson(res, 404, {
        error: {
          code: "INVALID_REQUEST",
          message: "Not found.",
          retryable: false,
        },
      });
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, {
        error: {
          code: "INVALID_REQUEST",
          message: "Method not allowed.",
          retryable: false,
        },
      });
      return;
    }

    const handler = route === "/v1/post" ? handlePost : handleArticle;
    handler(req, res, resolved).catch(() => {
      if (!res.headersSent) {
        sendReaderError(res, 500, "INTERNAL_ERROR", "Internal reader error.");
      } else {
        res.destroy();
      }
    });
  };
}

export function createXArticleReaderServer(
  options: XArticleReaderOptions = {},
) {
  return createServer(createXArticleReaderRequestHandler(options));
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const host = process.env.X_ARTICLE_READER_HOST ?? DEFAULT_HOST;
  const port = Number(process.env.X_ARTICLE_READER_PORT ?? DEFAULT_PORT);
  const server = createXArticleReaderServer();
  server.listen(port, host, () => {
    console.log(`[x-article-reader] listening on http://${host}:${port}`);
  });
}
