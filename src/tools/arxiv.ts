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
  const absPath = "/abs/";
  const absIndex = cleaned.indexOf(absPath);
  const idWithVersion =
    absIndex >= 0 ? cleaned.slice(absIndex + absPath.length) : cleaned;
  const match = idWithVersion.match(/^(.*?)(?:v(\d+))?$/);
  if (!match) return { id: idWithVersion, version: null };
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
  return `all:"${normalized}"`;
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

async function readResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      `arXiv API 応答がサイズ上限を超えています: ${contentLength} bytes`,
    );
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("arXiv API 応答がサイズ上限を超えています");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
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
  let text: string;
  try {
    text = await readResponseText(response);
  } catch (error) {
    if (error instanceof Error && error.message.includes("サイズ上限")) {
      throw error;
    }
    throw new Error(`arXiv API 応答の読み取りに失敗しました: ${String(error)}`);
  }
  if (!response.ok) {
    throw new Error(
      `arXiv API エラー ${response.status}: ${text.slice(0, 200)}`,
    );
  }
  const papers = await parseArxivFeed(text);
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
        description: `Sort order. Defaults to ${defaultSort}.`,
      },
    ),
  );

const searchParams = Type.Object({
  query: Type.String({
    description: "Natural-language query to search on arXiv.",
    minLength: 1,
    maxLength: 500,
  }),
  from: dateParam("Start of the submission-date range in YYYY-MM-DD format."),
  to: dateParam("End of the submission-date range in YYYY-MM-DD format."),
  max_results: Type.Optional(
    Type.Integer({
      description: "Maximum number of results. Defaults to 10; maximum 50.",
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
    "Search arXiv papers with a natural-language query. Supports filtering by submission date range.",
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
    description: "arXiv search queries to survey together using OR.",
    minItems: 1,
    maxItems: 8,
  }),
  from: dateParam("Start of the submission-date range in YYYY-MM-DD format."),
  to: dateParam("End of the submission-date range in YYYY-MM-DD format."),
  max_results: Type.Optional(
    Type.Integer({
      description: "Maximum number of results. Defaults to 30; maximum 50.",
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
    "Survey arXiv with multiple queries combined using OR. Useful for recurring or date-bounded literature surveys.",
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
