import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const HOST = process.env.X_ARTICLE_READER_HOST ?? "127.0.0.1";
const PORT = Number(process.env.X_ARTICLE_READER_PORT ?? "8788");
const TOKEN = process.env.X_ARTICLE_READER_TOKEN ?? "";

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PREVIEW_CHARS = 10_000;
const MAX_PLAIN_CHARS = 120_000;
const MAX_MEDIA = 100;

function sha256(value) {
  return createHash("sha256").update(value).digest();
}

function tokenMatches(actualBearer) {
  if (!TOKEN || !actualBearer) return false;
  return timingSafeEqual(sha256(actualBearer), sha256(TOKEN));
}

function sendJson(res, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendReaderError(res, status, code, message, retryable = false) {
  sendJson(res, status, { error: { code, message, retryable } });
}

async function readLimitedBody(req) {
  const contentLength = req.headers["content-length"];
  if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function truncateText(value, maxChars) {
  if (typeof value !== "string") return { value: undefined, truncated: false };
  if (value.length <= maxChars) return { value, truncated: false };
  return { value: value.slice(0, maxChars), truncated: true };
}

function normalizeArticle(input, articleId) {
  if (!input || typeof input !== "object") {
    throw new Error("UPSTREAM_CHANGED");
  }

  const preview = truncateText(input.previewText, MAX_PREVIEW_CHARS);
  const plain = truncateText(input.plainText, MAX_PLAIN_CHARS);
  const media = Array.isArray(input.media)
    ? input.media
        .filter((m) => m && typeof m === "object" && typeof m.url === "string")
        .slice(0, MAX_MEDIA)
        .map((m) => ({
          url: m.url,
          ...(typeof m.alt === "string" ? { alt: m.alt.slice(0, 2000) } : {}),
        }))
    : [];

  const article = {
    articleId,
    ...(typeof input.postId === "string" && /^\d{1,32}$/.test(input.postId)
      ? { postId: input.postId }
      : {}),
    canonicalUrl:
      typeof input.canonicalUrl === "string"
        ? input.canonicalUrl
        : `https://x.com/i/article/${articleId}`,
    ...(typeof input.title === "string" ? { title: input.title.slice(0, 500) } : {}),
    ...(input.author && typeof input.author === "object"
      ? {
          author: {
            ...(typeof input.author.name === "string"
              ? { name: input.author.name.slice(0, 200) }
              : {}),
            ...(typeof input.author.username === "string"
              ? { username: input.author.username.slice(0, 64) }
              : {}),
          },
        }
      : {}),
    ...(preview.value !== undefined ? { previewText: preview.value } : {}),
    ...(plain.value !== undefined ? { plainText: plain.value } : {}),
    media,
    ...(typeof input.publishedAt === "string" ? { publishedAt: input.publishedAt } : {}),
    source: "x-internal-graphql",
    contentTruncated:
      Boolean(input.contentTruncated) || preview.truncated || plain.truncated,
  };

  const encoded = Buffer.from(JSON.stringify(article));
  if (encoded.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("RESPONSE_TOO_LARGE");
  }
  return article;
}

async function loadFixtureArticle(articleId) {
  if (process.env.X_ARTICLE_READER_MOCK === "1") {
    return normalizeArticle(
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

  const fixturePath = process.env.X_ARTICLE_READER_FIXTURE;
  if (!fixturePath) return null;
  const raw = JSON.parse(await readFile(fixturePath, "utf8"));
  const candidate = raw?.articles?.[articleId] ?? raw;
  return normalizeArticle(candidate, articleId);
}

async function handleArticle(req, res) {
  const auth = req.headers.authorization ?? "";
  const bearer = typeof auth === "string" && auth.startsWith("Bearer ")
    ? auth.slice("Bearer ".length)
    : "";
  if (!tokenMatches(bearer)) {
    sendReaderError(res, 401, "INVALID_REQUEST", "Invalid reader token.", false);
    return;
  }

  const contentType = req.headers["content-type"] ?? "";
  if (!String(contentType).toLowerCase().startsWith("application/json")) {
    sendReaderError(res, 415, "INVALID_REQUEST", "Content-Type must be application/json.", false);
    return;
  }

  let body;
  try {
    body = JSON.parse(await readLimitedBody(req));
  } catch (err) {
    if (err instanceof Error && err.message === "REQUEST_TOO_LARGE") {
      sendReaderError(res, 413, "INVALID_REQUEST", "Request body is too large.", false);
      return;
    }
    sendReaderError(res, 400, "INVALID_REQUEST", "Request JSON is invalid.", false);
    return;
  }

  const articleId = body?.articleId;
  const format = body?.format;
  if (typeof articleId !== "string" || !/^\d{1,32}$/.test(articleId)) {
    sendReaderError(res, 400, "INVALID_REQUEST", "articleId must be 1-32 digits.", false);
    return;
  }
  if (format !== "preview" && format !== "plain") {
    sendReaderError(res, 400, "INVALID_REQUEST", "format must be preview or plain.", false);
    return;
  }

  try {
    const article = await loadFixtureArticle(articleId);
    if (!article) {
      sendReaderError(
        res,
        502,
        "UPSTREAM_CHANGED",
        "No host-side X Article upstream adapter is configured.",
        false,
      );
      return;
    }
    if (format === "preview") delete article.plainText;
    sendJson(res, 200, article);
  } catch (err) {
    const code = err instanceof Error ? err.message : "INTERNAL_ERROR";
    if (code === "RESPONSE_TOO_LARGE") {
      sendReaderError(res, 502, "RESPONSE_TOO_LARGE", "Reader response is too large.", false);
    } else if (code === "UPSTREAM_CHANGED") {
      sendReaderError(res, 502, "UPSTREAM_CHANGED", "Upstream response shape changed.", false);
    } else {
      console.error("[x-article-reader] internal error");
      sendReaderError(res, 500, "INTERNAL_ERROR", "Internal reader error.", false);
    }
  }
}

export function requestListener(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname !== "/v1/article") {
    sendJson(res, 404, { error: { code: "INVALID_REQUEST", message: "Not found.", retryable: false } });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: { code: "INVALID_REQUEST", message: "Method not allowed.", retryable: false } });
    return;
  }

  handleArticle(req, res).catch(() => {
    if (!res.headersSent) {
      sendReaderError(res, 500, "INTERNAL_ERROR", "Internal reader error.", false);
    } else {
      res.destroy();
    }
  });
}

export function createXArticleReaderServer() {
  return createServer(requestListener);
}

const isMainModule =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMainModule) {
  const server = createXArticleReaderServer();
  server.listen(PORT, HOST, () => {
    console.log(`[x-article-reader] listening on http://${HOST}:${PORT}`);
  });
}
