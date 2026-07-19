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

export interface ParsedFeedMetadata {
  title: string;
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
type EntryBatchHandler = (entries: RssEntry[]) => void;
type ConditionalHeaders = { etag: string | null; lastModified: string | null };

const ENTRY_BATCH_SIZE = 100;

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

function normalizeItem(item: FeedParser.Item): RssEntry {
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
}

async function parseFeed(
  body: Uint8Array,
  options: ParseFeedOptions,
  onBatch: EntryBatchHandler,
): Promise<ParsedFeedMetadata> {
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
  let batch: RssEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    parser.on("data", (item: FeedParser.Item) => {
      batch.push(normalizeItem(item));
      if (batch.length < ENTRY_BATCH_SIZE) return;
      const entries = batch;
      batch = [];
      onBatch(entries);
    });
    parser.once("error", reject);
    parser.once("end", () => {
      if (batch.length > 0) onBatch(batch);
      resolve();
    });
    parser.end(xml);
  });

  return { title: parser.meta.title?.trim() ?? "" };
}

export async function parseFeedBytes(
  body: Uint8Array,
  options: ParseFeedOptions,
): Promise<ParsedFeed> {
  const entries: RssEntry[] = [];
  const metadata = await parseFeed(body, options, (batch) => {
    entries.push(...batch);
  });
  return { ...metadata, entries };
}

export function parseFeedBytesInBatches(
  body: Uint8Array,
  options: ParseFeedOptions,
  onBatch: EntryBatchHandler,
): Promise<ParsedFeedMetadata> {
  return parseFeed(body, options, onBatch);
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
  conditional?: ConditionalHeaders,
): Promise<FetchFeedResult> {
  return fetchAndParseFeed(url, parseFeedBytes, conditional);
}

async function fetchAndParseFeed<T>(
  url: string,
  parse: (body: Uint8Array, options: ParseFeedOptions) => Promise<T>,
  conditional?: ConditionalHeaders,
): Promise<
  | { notModified: true }
  | {
      notModified: false;
      feed: T;
      etag: string | null;
      lastModified: string | null;
    }
> {
  const headers: Record<string, string> = {
    Accept:
      "application/rss+xml, application/atom+xml, application/rdf+xml, application/xml, text/xml",
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
    feed: await parse(body, {
      baseUrl: response.url || url,
      contentType: response.headers.get("content-type"),
    }),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

export async function fetchFeedInBatches(
  url: string,
  onBatch: EntryBatchHandler,
  conditional?: ConditionalHeaders,
): Promise<
  | { notModified: true }
  | {
      notModified: false;
      feed: ParsedFeedMetadata;
      etag: string | null;
      lastModified: string | null;
    }
> {
  return fetchAndParseFeed(
    url,
    (body, options) => parseFeedBytesInBatches(body, options, onBatch),
    conditional,
  );
}
