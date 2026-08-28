import type { AgentTool } from "@earendil-works/pi-agent-core";
import FeedParser from "feedparser";
import { Type } from "typebox";

const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export type ArxivPaper = {
  id: string;
  version: number | null;
  title: string;
  authors: string[];
  submitted_at: string;
  updated_at: string;
  categories: string[];
  abstract: string;
  url: string;
  pdf_url: string;
};

type ArxivSort = "relevance" | "submitted" | "updated";

type RawAtomNode =
  | string
  | {
      "#"?: unknown;
      name?: unknown;
    };

function normalizeWhitespace(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function atomText(value: unknown): string {
  if (typeof value === "string") return normalizeWhitespace(value);
  if (!value || typeof value !== "object") return "";
  const node = value as Exclude<RawAtomNode, string>;
  if (typeof node["#"] === "string") return normalizeWhitespace(node["#"]);
  if (typeof node.name === "string") return normalizeWhitespace(node.name);
  if (node.name && typeof node.name === "object") {
    const nested = node.name as { "#"?: unknown };
    if (typeof nested["#"] === "string") {
      return normalizeWhitespace(nested["#"]);
    }
  }
  return "";
}

function extractAuthors(item: FeedParser.Item): string[] {
  const raw = item["atom:author"];
  const nodes = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const authors = nodes
    .map((node) => {
      if (typeof node === "string") return normalizeWhitespace(node);
      if (!node || typeof node !== "object") return "";
      const authorNode = node as { name?: unknown; "#"?: unknown };
      return atomText(authorNode.name ?? authorNode);
    })
    .filter(Boolean);

  if (authors.length > 0) return [...new Set(authors)];
  const fallback = normalizeWhitespace(item.author);
  return fallback ? [fallback] : [];
}

function parseArxivId(value: string): { id: string; version: number | null } {
  const cleaned = value.trim().replace(/\/$/, "");
  const last = cleaned.split("/").at(-1) ?? cleaned;
  const match = last.match(/^(.*?)(?:v(\d+))?$/);
  if (!match) return { id: last, version: null };
  return {
    id: match[1],
    version: match[2] ? Number(match[2]) : null,
  };
}

function normalizeItem(item: FeedParser.Item): ArxivPaper {
  const rawId = item.guid || item.link || "";
  const { id, version } = parseArxivId(rawId);
  const submitted = item.pubdate;
  const updated = item.date ?? submitted;
  const categories = Array.isArray(item.categories)
    ? item.categories.filter(
        (category: unknown): category is string => typeof category === "string",
      )
    : [];
  return {
    id,
    version,
    title: normalizeWhitespace(item.title) || "(タイトルなし)",
    authors: extractAuthors(item),
    submitted_at:
      submitted && Number.isFinite(submitted.getTime())
        ? submitted.toISOString()
        : "",
    updated_at:
      updated && Number.isFinite(updated.getTime())
        ? updated.toISOString()
        : "",
    categories: [...new Set(categories)],
    abstract: normalizeWhitespace(item.summary ?? item.description),
    url: id ? `https://arxiv.org/abs/${id}` : item.link || "",
    pdf_url: id ? `https://arxiv.org/pdf/${id}` : "",
  };
}

export async function parseArxivFeed(xml: string): Promise<ArxivPaper[]> {
  const parser = new FeedParser({ feedurl: ARXIV_API_URL });
  const papers: ArxivPaper[] = [];
  await new Promise<void>((resolve, reject) => {
    parser.on("data", (item: FeedParser.Item) =>
      papers.push(normalizeItem(item)),
    );
    parser.once("error", reject);
    parser.once("end", resolve);
    parser.end(xml);
  });
  return papers;
}

function parseDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} は YYYY-MM-DD 形式で指定してください: ${value}`);
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${label} が不正な日付です: ${value}`);
  }
  return value.replaceAll("-", "");
}

function formatNaturalLanguageQuery(query: string): string {
  const normalized = normalizeWhitespace(query).replace(/["\\]/g, " ").trim();
  if (!normalized) throw new Error("検索クエリが空です");
  return `all:\"${normalized}\"`;
}

export function buildArxivSearchQuery(
  queries: readonly string[],
  from?: string,
  to?: string,
): string {
  if (queries.length === 0)
    throw new Error("検索クエリを1件以上指定してください");
  const terms = queries.map(formatNaturalLanguageQuery);
  const expression = terms.length === 1 ? terms[0] : `(${terms.join(" OR ")})`;

  if (!from && !to) return expression;
  const fromValue = from ? `${parseDate(from, "from")}0000` : "199101010000";
  const toValue = to ? `${parseDate(to, "to")}2359` : "999912312359";
  if (fromValue > toValue)
    throw new Error("from は to 以前の日付にしてください");
  return `${expression} AND submittedDate:[${fromValue} TO ${toValue}]`;
}

function mapSort(sort: ArxivSort): string {
  if (sort === "submitted") return "submittedDate";
  if (sort === "updated") return "lastUpdatedDate";
  return "relevance";
}

export function buildArxivApiUrl(input: {
  queries: readonly string[];
  from?: string;
  to?: string;
  maxResults: number;
  sort: ArxivSort;
}): string {
  const params = new URLSearchParams({
    search_query: buildArxivSearchQuery(input.queries, input.from, input.to),
    start: "0",
    max_results: String(input.maxResults),
    sortBy: mapSort(input.sort),
    sortOrder: "descending",
  });
  return `${ARXIV_API_URL}?${params.toString()}`;
}

async function fetchArxiv(input: {
  queries: readonly string[];
  from?: string;
  to?: string;
  maxResults: number;
  sort: ArxivSort;
}): Promise<ArxivPaper[]> {
  const url = buildArxivApiUrl(input);
  const response = await fetch(url, {
    headers: {
      Accept: "application/atom+xml, application/xml, text/xml",
      "User-Agent": "my-discord-agent/arxiv",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `arXiv API エラー ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `arXiv API 応答がサイズ上限を超えています: ${contentLength} bytes`,
    );
  }
  const xml = await response.text();
  if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("arXiv API 応答がサイズ上限を超えています");
  }
  const papers = await parseArxivFeed(xml);
  const deduplicated = new Map<string, ArxivPaper>();
  for (const paper of papers) {
    const key = paper.id || paper.url;
    if (!deduplicated.has(key)) deduplicated.set(key, paper);
  }
  return [...deduplicated.values()];
}

const dateParam = (description: string) =>
  Type.Optional(
    Type.String({
      description,
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
    }),
  );

const sortParam = (defaultSort: ArxivSort) =>
  Type.Optional(
    Type.Union(
      [
        Type.Literal("relevance"),
        Type.Literal("submitted"),
        Type.Literal("updated"),
      ],
      {
        description: `並び順（デフォルト: ${defaultSort}）`,
      },
    ),
  );

const searchParams = Type.Object({
  query: Type.String({
    description: "arXivを検索する自然言語クエリ",
    minLength: 1,
    maxLength: 500,
  }),
  from: dateParam("投稿日範囲の開始日（YYYY-MM-DD）"),
  to: dateParam("投稿日範囲の終了日（YYYY-MM-DD）"),
  max_results: Type.Optional(
    Type.Integer({
      description: "最大件数（デフォルト: 10、最大: 50）",
      minimum: 1,
      maximum: 50,
    }),
  ),
  sort: sortParam("relevance"),
});

export const arxivSearchTool: AgentTool<typeof searchParams> = {
  name: "arxiv-search",
  label: "arXiv Search",
  description:
    "arXivの論文を自然言語クエリで検索する。投稿日範囲を指定した検索にも対応する",
  parameters: searchParams,
  execute: async (
    _toolCallId,
    { query, from, to, max_results = 10, sort = "relevance" },
  ) => {
    const papers = await fetchArxiv({
      queries: [query],
      from,
      to,
      maxResults: Math.min(max_results, 50),
      sort: sort as ArxivSort,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(papers, null, 2) }],
      details: { query, from, to, resultCount: papers.length },
    };
  },
};

const surveyParams = Type.Object({
  queries: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    description: "まとめて調査するarXiv検索クエリ（OR検索）",
    minItems: 1,
    maxItems: 8,
  }),
  from: dateParam("投稿日範囲の開始日（YYYY-MM-DD）"),
  to: dateParam("投稿日範囲の終了日（YYYY-MM-DD）"),
  max_results: Type.Optional(
    Type.Integer({
      description: "最大件数（デフォルト: 30、最大: 50）",
      minimum: 1,
      maximum: 50,
    }),
  ),
  sort: sortParam("submitted"),
});

export const arxivSurveyTool: AgentTool<typeof surveyParams> = {
  name: "arxiv-survey",
  label: "arXiv Survey",
  description:
    "複数の検索クエリをOR条件でまとめてarXiv調査する。期間指定の定期サーベイに使う",
  parameters: surveyParams,
  execute: async (
    _toolCallId,
    { queries, from, to, max_results = 30, sort = "submitted" },
  ) => {
    const papers = await fetchArxiv({
      queries,
      from,
      to,
      maxResults: Math.min(max_results, 50),
      sort: sort as ArxivSort,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(papers, null, 2) }],
      details: { queries, from, to, resultCount: papers.length },
    };
  },
};
