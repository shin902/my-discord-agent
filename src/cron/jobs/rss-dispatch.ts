import { z } from "zod";
import {
  claimUnreadArticles,
  markArticlesRead,
  openRssDb,
  releaseDispatchArticles,
  type UnreadArticle,
} from "../../rss/store.js";
import { NonRetryableError } from "../../utils/error.js";
import { enqueueCronInbox } from "../enqueue.js";
import type { CronContext } from "../runner.js";

const FeedSchema = z.union([
  z
    .string()
    .url()
    .transform((url) => ({ url, name: undefined })),
  z.object({
    url: z.string().url(),
    name: z.string().min(1).optional(),
  }),
]);

const SettingsSchema = z.object({
  feeds: z.array(FeedSchema).min(1).optional(),
  maxItemsPerRun: z.number().int().min(1).max(50).default(10),
  maxSummaryChars: z.number().int().min(0).max(12_000).default(4_000),
  statePath: z.string().min(1).optional(),
});

const MAX_INBOX_CONTENT_CHARS = 64_000;
const MAX_FEED_NAME_CHARS = 200;
const MAX_TITLE_CHARS = 500;
const MAX_URL_CHARS = 2_048;
const MAX_PUBLISHED_AT_CHARS = 100;

function formatArticle(
  article: UnreadArticle,
  maxSummaryChars: number,
): string {
  return [
    `## RSS記事 ${article.id}`,
    `フィード: ${article.feedName.slice(0, MAX_FEED_NAME_CHARS)} (${article.feedUrl.slice(0, MAX_URL_CHARS)})`,
    `タイトル: ${article.title.slice(0, MAX_TITLE_CHARS)}`,
    article.link ? `URL: ${article.link.slice(0, MAX_URL_CHARS)}` : "",
    article.publishedAt
      ? `公開日時: ${article.publishedAt.slice(0, MAX_PUBLISHED_AT_CHARS)}`
      : "",
    "RSS概要:",
    article.summary.slice(0, maxSummaryChars) || "(概要なし)",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildContent(
  instructions: string,
  articles: UnreadArticle[],
  maxSummaryChars: number,
): { content: string; queuedArticles: UnreadArticle[] } {
  let content = instructions;
  if (content.length > MAX_INBOX_CONTENT_CHARS) {
    throw new NonRetryableError(
      `[rss-dispatch] promptが長すぎます（上限${MAX_INBOX_CONTENT_CHARS}文字）`,
    );
  }

  const queuedArticles: UnreadArticle[] = [];
  for (const article of articles) {
    const block = formatArticle(article, maxSummaryChars);
    if (content.length + 2 + block.length > MAX_INBOX_CONTENT_CHARS) continue;
    content += `\n\n${block}`;
    queuedArticles.push(article);
  }
  if (queuedArticles.length === 0) {
    throw new NonRetryableError(
      "[rss-dispatch] promptが長すぎてinboxの文字数上限内に記事を追加できません",
    );
  }
  return { content, queuedArticles };
}

export default async function handler(ctx: CronContext): Promise<void> {
  const instructions = ctx.prompt?.trim();
  if (!instructions) {
    throw new NonRetryableError("[rss-dispatch] promptが設定されていません");
  }
  const parsed = SettingsSchema.safeParse(ctx.settings ?? {});
  if (!parsed.success) {
    throw new NonRetryableError(
      `[rss-dispatch] settings が不正です: ${parsed.error.message}`,
    );
  }
  const settings = parsed.data;
  const feedUrls = settings.feeds
    ? [...new Set(settings.feeds.map((feed) => feed.url))]
    : undefined;
  const db = openRssDb(settings.statePath);
  try {
    const dispatch = claimUnreadArticles(
      db,
      `${ctx.id}:${JSON.stringify(feedUrls ? [...feedUrls].sort() : null)}`,
      settings.maxItemsPerRun,
      feedUrls,
    );
    if (!dispatch) return;

    const { content, queuedArticles } = buildContent(
      instructions,
      dispatch.articles,
      settings.maxSummaryChars,
    );

    const queuedIds = new Set(queuedArticles.map((article) => article.id));
    releaseDispatchArticles(
      db,
      dispatch.id,
      dispatch.articles
        .filter((article) => !queuedIds.has(article.id))
        .map((article) => article.id),
    );

    await enqueueCronInbox(
      { ...ctx, idempotencyKey: dispatch.jobId, rssDispatchId: dispatch.id, rssStatePath: settings.statePath },
      content,
    );
    markArticlesRead(
      db,
      queuedArticles.map((article) => article.id),
    );
    console.log(
      `[rss-dispatch] ${queuedArticles.length}件をinboxへ投入し、既読にしました`,
    );
  } finally {
    db.close();
  }
}
