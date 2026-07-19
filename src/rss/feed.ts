import { createHash } from "node:crypto";
import { parse as parseContentType } from "content-type";
import { decodeBuffer } from "encoding-sniffer";
import FeedParser from "feedparser";
import { convert } from "html-to-text";

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_ENTRY_SUMMARY_CHARS = 12_000;

export interface RssEntry {
  entryId: string;
  title: string;
  link: string;
  publishedAt: string;
  summary: string;
}

export interface ParsedFeed {
  title: string;
  entries: RssEntry[];
}

export type FetchFeedResult =
  | { notModified: true }
  | {
      notModified: false;
      feed: ParsedFeed;
      etag: string | null;
      lastModified: string | null;
    };

type ParseFeedOptions = { baseUrl: string; contentType?: string | null };

function stableEntryId(
  guid: string,
  link: string,
  title: string,
  publishedAt: string,
  summary: string,
): string {
  if (guid) return `guid:${guid}`;
  if (link) return `link:${link}`;
  return `hash:${createHash("sha256")
    .update([title, publishedAt, summary].join("\n"))
    .digest("hex")}`;
}

function summaryText(value: string | null): string {
  return value ? convert(value, { wordwrap: false }).trim() : "";
}

export async function parseFeedBytes(
  body: Uint8Array,
  options: ParseFeedOptions,
): Promise<ParsedFeed> {
  let charset: string | undefined;
  try {
    charset = options.contentType
      ? parseContentType(options.contentType).parameters.charset
      : undefined;
  } catch {
    charset = undefined;
  }
  const xml = decodeBuffer(Buffer.from(body), {
    defaultEncoding: "utf-8",
    transportLayerEncodingLabel: charset,
  });
  const parser = new FeedParser({ feedurl: options.baseUrl });
  const items: FeedParser.Item[] = [];
  const collectItems = (async () => {
    for await (const item of parser) items.push(item);
  })();
  parser.end(xml);
  await collectItems;

  const entries = items.map((item): RssEntry => {
    const title = item.title?.trim() || "(タイトルなし)";
    const link = item.link?.trim() ?? "";
    const guid = item.guid?.trim() ?? "";
    const date = item.pubdate ?? item.date;
    const publishedAt =
      date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
    const summary = summaryText(item.summary ?? item.description).slice(
      0,
      MAX_ENTRY_SUMMARY_CHARS,
    );
    return {
      entryId: stableEntryId(
        guid === link ? "" : guid,
        link,
        title,
        publishedAt,
        summary,
      ),
      title,
      link,
      publishedAt,
      summary,
    };
  });

  return {
    title: parser.meta.title?.trim() ?? "",
    entries,
  };
}

async function readFeedBody(response: Response, url: string): Promise<Buffer> {
  if (!response.body) {
    throw new Error(`RSSのレスポンス本文がありません: ${url}`);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > MAX_FEED_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`RSSがサイズ上限を超えています: ${url}`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks, total);
}

export async function fetchFeed(
  url: string,
  conditional?: { etag: string | null; lastModified: string | null },
): Promise<FetchFeedResult> {
  const headers: Record<string, string> = {
    Accept:
      "application/rss+xml, application/atom+xml, application/xml, text/xml",
    "User-Agent": "my-discord-agent/rss-collector",
  };
  if (conditional?.etag) headers["If-None-Match"] = conditional.etag;
  if (conditional?.lastModified) {
    headers["If-Modified-Since"] = conditional.lastModified;
  }

  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 304) return { notModified: true };
  if (!response.ok) {
    throw new Error(`RSS取得エラー ${response.status}: ${url}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_FEED_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`RSSがサイズ上限を超えています: ${contentLength} bytes`);
  }
  const body = await readFeedBody(response, url);
  return {
    notModified: false,
    feed: await parseFeedBytes(body, {
      baseUrl: response.url || url,
      contentType: response.headers.get("content-type"),
    }),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}
