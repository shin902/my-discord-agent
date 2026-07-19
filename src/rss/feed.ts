import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function xmlText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map(xmlText).find(Boolean) ?? "";
  }
  const record = asRecord(value);
  if (!record) return "";
  return xmlText(record["#text"] ?? record.__cdata);
}

function entryLink(value: unknown): string {
  for (const candidate of asArray(value)) {
    if (typeof candidate === "string") return candidate.trim();
    const record = asRecord(candidate);
    if (!record) continue;
    const rel = xmlText(record["@_rel"]);
    const href = xmlText(record["@_href"]);
    if (href && (!rel || rel === "alternate")) return href;
    const text = xmlText(record);
    if (text) return text;
  }
  return "";
}

function plainText(value: string): string {
  return value
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|h[1-6]|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) =>
      String.fromCodePoint(Number.parseInt(n, 10)),
    )
    .replace(/&#x([\da-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(Number.parseInt(n, 16)),
    )
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function normalizeDate(value: string): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : value;
}

export function parseFeedXml(xml: string): ParsedFeed {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(`RSS XMLが不正です: ${validation.err.msg}`);
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    removeNSPrefix: true,
    parseTagValue: false,
    trimValues: true,
  });
  const parsed = asRecord(parser.parse(xml));
  const rssChannel = asRecord(asRecord(parsed?.rss)?.channel);
  const atomFeed = asRecord(parsed?.feed);
  const rdfFeed = asRecord(parsed?.RDF);
  const container = rssChannel ?? atomFeed ?? rdfFeed;
  if (!container) throw new Error("RSSまたはAtomフィードとして認識できません");

  const rawEntries = rssChannel
    ? asArray(rssChannel.item)
    : atomFeed
      ? asArray(atomFeed.entry)
      : asArray(rdfFeed?.item);
  const entries: RssEntry[] = [];

  for (const rawEntry of rawEntries) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    const title = plainText(xmlText(entry.title)) || "(タイトルなし)";
    const link = entryLink(entry.link);
    const guid = xmlText(entry.guid ?? entry.id);
    const publishedAt = normalizeDate(
      xmlText(entry.pubDate ?? entry.published ?? entry.updated ?? entry.date),
    );
    const summary = plainText(
      xmlText(
        entry.description ?? entry.summary ?? entry.content ?? entry.encoded,
      ),
    ).slice(0, MAX_ENTRY_SUMMARY_CHARS);
    entries.push({
      entryId: stableEntryId(guid, link, title, publishedAt, summary),
      title,
      link,
      publishedAt,
      summary,
    });
  }

  return {
    title: plainText(xmlText(container.title)),
    entries,
  };
}

async function readFeedBody(response: Response, url: string): Promise<string> {
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

  return Buffer.concat(chunks, total).toString("utf-8");
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
    throw new Error(`RSSがサイズ上限を超えています: ${contentLength} bytes`);
  }
  const xml = await readFeedBody(response, url);
  return {
    notModified: false,
    feed: parseFeedXml(xml),
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}
