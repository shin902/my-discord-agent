import {
  readXCookieStore,
  XCookieInvalidError,
  XCookieMissingError,
  XCookieStaleError,
} from "./x-cookie-store.js";

const GRAPHQL_BASE = "https://x.com/i/api/graphql";
const ARTICLE_REDIRECT_QUERY_ID = "zrSRXJmE1vj37AUmkh2oGg";
const ARTICLE_REDIRECT_OP_NAME = "ArticleRedirectScreenQuery";
const TWEET_RESULT_QUERY_ID = "Xl5pC_lBk_gcO2ItU39DQw";
const TWEET_RESULT_OP_NAME = "TweetResultByRestId";
const UPSTREAM_TIMEOUT_MS = 15_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 2 * 1024 * 1024;
const X_WEB_BEARER_TOKEN =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TWEET_RESULT_BY_REST_ID_FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_enhance_cards_enabled: false,
} as const;

type ReaderErrorCode =
  | "INVALID_REQUEST"
  | "ARTICLE_NOT_FOUND"
  | "AUTH_EXPIRED"
  | "RATE_LIMITED"
  | "UPSTREAM_CHANGED"
  | "UPSTREAM_TIMEOUT"
  | "RESPONSE_TOO_LARGE"
  | "INTERNAL_ERROR";

type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type XArticleUpstreamOptions = {
  cookieFile?: string;
  maxCookieAgeDays?: number;
  graphqlBaseUrl?: string;
  articleRedirectQueryId?: string;
  tweetResultQueryId?: string;
  bearerToken?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
  nowMs?: number;
};

export class XArticleUpstreamError extends Error {
  code: ReaderErrorCode;
  retryable: boolean;

  constructor(code: ReaderErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "XArticleUpstreamError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function getObject(
  value: unknown,
  path: readonly string[],
): Record<string, unknown> | undefined {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return isObject(current) ? current : undefined;
}

function getString(
  value: unknown,
  path: readonly string[],
): string | undefined {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function buildGraphqlUrl(
  baseUrl: string,
  queryId: string,
  operationName: string,
  params: Record<string, unknown>,
): string {
  const url = new URL(
    `${baseUrl.replace(/\/$/, "")}/${queryId}/${operationName}`,
  );
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  return url.toString();
}

async function readLimitedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new XArticleUpstreamError(
      "UPSTREAM_CHANGED",
      "X upstream response body is empty.",
    );
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
      await reader.cancel();
      throw new XArticleUpstreamError(
        "RESPONSE_TOO_LARGE",
        "X upstream response exceeded size limit.",
      );
    }
    chunks.push(value);
  }

  const body = Buffer.concat(chunks, total).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new XArticleUpstreamError(
      "UPSTREAM_CHANGED",
      "X upstream returned invalid JSON.",
    );
  }
}

function mapHttpStatus(status: number): XArticleUpstreamError {
  if (status === 401 || status === 403) {
    return new XArticleUpstreamError(
      "AUTH_EXPIRED",
      "The host-side X session has expired.",
    );
  }
  if (status === 429) {
    return new XArticleUpstreamError(
      "RATE_LIMITED",
      "X upstream rate limited the reader.",
      true,
    );
  }
  if (status === 404) {
    return new XArticleUpstreamError(
      "ARTICLE_NOT_FOUND",
      "The requested X Article was not found.",
    );
  }
  return new XArticleUpstreamError(
    "UPSTREAM_CHANGED",
    "X upstream returned an unexpected status.",
    status >= 500,
  );
}

async function graphqlGet(
  url: string,
  headers: Record<string, string>,
  options: Required<Pick<XArticleUpstreamOptions, "timeoutMs" | "fetchImpl">>,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw mapHttpStatus(response.status);
    return await readLimitedJson(response);
  } catch (err) {
    if (err instanceof XArticleUpstreamError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new XArticleUpstreamError(
        "UPSTREAM_TIMEOUT",
        "X upstream request timed out.",
        true,
      );
    }
    throw new XArticleUpstreamError(
      "UPSTREAM_CHANGED",
      "X upstream request failed.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function extractTweetId(redirect: unknown): string {
  const result = getObject(redirect, [
    "data",
    "article_result_by_rest_id",
    "result",
  ]);
  if (!result) {
    throw new XArticleUpstreamError(
      "UPSTREAM_CHANGED",
      "X Article redirect response shape changed.",
    );
  }

  const tweetId = getString(result, ["metadata", "tweet_results", "rest_id"]);
  if (!tweetId) {
    throw new XArticleUpstreamError(
      "ARTICLE_NOT_FOUND",
      "The requested X Article was not found.",
    );
  }
  return tweetId;
}

function extractArticle(tweetResponse: unknown): {
  tweetResult: Record<string, unknown>;
  article: Record<string, unknown>;
} {
  const tweetResult = getObject(tweetResponse, [
    "data",
    "tweetResult",
    "result",
  ]);
  if (!tweetResult) {
    throw new XArticleUpstreamError(
      "UPSTREAM_CHANGED",
      "X TweetResult response shape changed.",
    );
  }

  const article = getObject(tweetResult, [
    "article",
    "article_results",
    "result",
  ]);
  if (!article) {
    throw new XArticleUpstreamError(
      "ARTICLE_NOT_FOUND",
      "The requested X Article payload was not returned.",
    );
  }
  return { tweetResult, article };
}

function extractMedia(
  article: Record<string, unknown>,
): Array<{ url: string }> {
  const urls: string[] = [];
  const coverUrl = getString(article, [
    "cover_media",
    "media_info",
    "original_img_url",
  ]);
  if (coverUrl) urls.push(coverUrl);

  const mediaEntities = article.media_entities;
  if (Array.isArray(mediaEntities)) {
    for (const entry of mediaEntities) {
      const url = getString(entry, ["media_info", "original_img_url"]);
      if (url) urls.push(url);
    }
  }

  return [...new Set(urls)].map((url) => ({ url }));
}

function parsePublishedAt(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const ms = new Date(raw).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function normalizeUpstreamArticle(
  articleId: string,
  tweetId: string,
  tweetResult: Record<string, unknown>,
  article: Record<string, unknown>,
): Record<string, unknown> {
  const userLegacy = getObject(tweetResult, [
    "core",
    "user_results",
    "result",
    "legacy",
  ]);
  const tweetLegacy = getObject(tweetResult, ["legacy"]);
  const author = {
    ...(typeof userLegacy?.name === "string" ? { name: userLegacy.name } : {}),
    ...(typeof userLegacy?.screen_name === "string"
      ? { username: userLegacy.screen_name }
      : {}),
  };

  return {
    postId: tweetId,
    canonicalUrl: `https://x.com/i/article/${articleId}`,
    ...(typeof article.title === "string" ? { title: article.title } : {}),
    ...(Object.keys(author).length > 0 ? { author } : {}),
    ...(typeof article.preview_text === "string"
      ? { previewText: article.preview_text }
      : {}),
    ...(typeof article.plain_text === "string"
      ? { plainText: article.plain_text }
      : {}),
    media: extractMedia(article),
    ...(typeof tweetLegacy?.created_at === "string"
      ? { publishedAt: parsePublishedAt(tweetLegacy.created_at) }
      : {}),
    contentTruncated: false,
  };
}

function mapCookieError(err: unknown): never {
  if (
    err instanceof XCookieMissingError ||
    err instanceof XCookieInvalidError ||
    err instanceof XCookieStaleError
  ) {
    throw new XArticleUpstreamError(
      "AUTH_EXPIRED",
      "The host-side X session cookie is unavailable or stale.",
    );
  }
  throw err;
}

export async function fetchXArticleFromGraphql(
  articleId: string,
  options: XArticleUpstreamOptions = {},
): Promise<Record<string, unknown>> {
  let storedCookies: Awaited<ReturnType<typeof readXCookieStore>>;
  try {
    storedCookies = await readXCookieStore({
      cookieFile: options.cookieFile,
      maxAgeDays: options.maxCookieAgeDays,
      nowMs: options.nowMs,
    });
  } catch (err) {
    mapCookieError(err);
  }

  const graphqlBaseUrl = options.graphqlBaseUrl ?? GRAPHQL_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const headers = {
    authorization: `Bearer ${options.bearerToken ?? X_WEB_BEARER_TOKEN}`,
    "content-type": "application/json",
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    referer: "https://x.com/",
    "user-agent": USER_AGENT,
    "x-csrf-token": storedCookies.csrfToken,
    "x-twitter-active-user": "yes",
    "x-twitter-auth-type": "OAuth2Session",
    "x-twitter-client-language": "en",
    cookie: storedCookies.cookieHeader,
  } satisfies Record<string, string>;

  const redirectUrl = buildGraphqlUrl(
    graphqlBaseUrl,
    options.articleRedirectQueryId ?? ARTICLE_REDIRECT_QUERY_ID,
    ARTICLE_REDIRECT_OP_NAME,
    {
      variables: { articleEntityId: articleId },
      features: {},
    },
  );
  const redirect = await graphqlGet(redirectUrl, headers, {
    fetchImpl,
    timeoutMs,
  });
  const tweetId = extractTweetId(redirect);

  const tweetUrl = buildGraphqlUrl(
    graphqlBaseUrl,
    options.tweetResultQueryId ?? TWEET_RESULT_QUERY_ID,
    TWEET_RESULT_OP_NAME,
    {
      variables: {
        tweetId,
        withCommunity: false,
        includePromotedContent: false,
        withVoice: false,
      },
      features: TWEET_RESULT_BY_REST_ID_FEATURES,
      fieldToggles: {
        withArticleRichContentState: true,
        withArticlePlainText: true,
        withGrokAnalyze: false,
      },
    },
  );
  const tweetResponse = await graphqlGet(tweetUrl, headers, {
    fetchImpl,
    timeoutMs,
  });
  const { tweetResult, article } = extractArticle(tweetResponse);

  return normalizeUpstreamArticle(articleId, tweetId, tweetResult, article);
}
