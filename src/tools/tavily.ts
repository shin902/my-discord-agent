import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const searchParams = Type.Object({
  query: Type.String({ description: "Search query." }),
  max_results: Type.Optional(
    Type.Integer({
      description: "Maximum number of results. Defaults to 5; maximum 10.",
      minimum: 1,
      maximum: 10,
    }),
  ),
  search_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description:
        "Search depth: basic is faster, advanced is more detailed but slower. Defaults to basic.",
    }),
  ),
  include_answer: Type.Optional(
    Type.Boolean({
      description:
        "Whether to include an AI-generated answer summary. Defaults to true.",
    }),
  ),
  topic: Type.Optional(
    Type.Union(
      [Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")],
      {
        description: "Search topic. Defaults to general.",
      },
    ),
  ),
});

type TavilyResult = {
  title: string;
  url: string;
  content: string;
  score: number;
};

type TavilyResponse = {
  answer?: string;
  results: TavilyResult[];
};

export const tavilySearchTool: AgentTool<typeof searchParams> = {
  name: "tavily-search",
  label: "Tavily Search",
  description:
    "Run a web search and return results. Use it for current information and fact-checking.",
  parameters: searchParams,
  execute: async (
    _toolCallId,
    {
      query,
      max_results = 5,
      search_depth = "basic",
      include_answer = true,
      topic = "general",
    },
  ) => {
    const baseUrl = resolveProxyBaseUrl("tavily");
    const res = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        max_results: Math.min(max_results, 10),
        search_depth,
        include_answer,
        topic,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily API エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as TavilyResponse;
    const results = data.results ?? [];

    const lines: string[] = [];
    if (data.answer) {
      lines.push("## 回答", "", data.answer, "");
    }
    lines.push("## 検索結果", "");
    for (const r of results) {
      lines.push(`### ${r.title ?? "(タイトルなし)"}`);
      if (r.url) lines.push(`- URL: ${r.url}`);
      if (typeof r.score === "number")
        lines.push(`- スコア: ${r.score.toFixed(2)}`);
      if (r.content) lines.push(`- ${r.content}`);
      lines.push("");
    }
    if (results.length === 0) lines.push("(結果なし)");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { query, resultCount: results.length },
    };
  },
};

const extractParams = Type.Object({
  urls: Type.Array(Type.String(), {
    description: "URLs whose page content should be extracted.",
  }),
  extract_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description:
        "Extraction depth: basic is faster, advanced is more detailed but slower. Defaults to basic.",
    }),
  ),
  include_images: Type.Optional(
    Type.Boolean({
      description: "Whether to include image URLs. Defaults to false.",
    }),
  ),
});

type TavilyExtractResult = {
  url: string;
  raw_content?: string;
};

type TavilyExtractFailure = {
  url: string;
  error: string;
};

type TavilyExtractResponse = {
  results?: TavilyExtractResult[];
  failed_results?: TavilyExtractFailure[];
};

export const tavilyExtractTool: AgentTool<typeof extractParams> = {
  name: "tavily-extract",
  label: "Tavily Extract",
  description:
    "Extract page content from specified URLs. Use it to read search-result pages in detail.",
  parameters: extractParams,
  execute: async (
    _toolCallId,
    { urls, extract_depth = "basic", include_images = false },
  ) => {
    const baseUrl = resolveProxyBaseUrl("tavily");
    const res = await fetch(`${baseUrl}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ urls, extract_depth, include_images }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily API エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as TavilyExtractResponse;
    const results = data.results ?? [];
    const failedResults = data.failed_results ?? [];

    const lines: string[] = [];
    for (const r of results) {
      lines.push(`## ${r.url}`, "", r.raw_content ?? "(本文なし)", "");
    }
    for (const f of failedResults) {
      lines.push(`## ${f.url} (失敗)`, "", f.error ?? "", "");
    }
    if (results.length === 0 && failedResults.length === 0) {
      lines.push("(結果なし)");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        urls,
        resultCount: results.length,
        failedCount: failedResults.length,
      },
    };
  },
};

const crawlParams = Type.Object({
  url: Type.String({ description: "Root URL where crawling should start." }),
  max_depth: Type.Optional(
    Type.Integer({
      description: "Crawl depth from 1 to 5. Defaults to 1.",
      minimum: 1,
      maximum: 5,
    }),
  ),
  max_breadth: Type.Optional(
    Type.Integer({
      description:
        "Number of links to follow per page, from 1 to 500. Defaults to 20.",
      minimum: 1,
      maximum: 500,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Maximum total number of pages to process. Defaults to 50.",
      minimum: 1,
    }),
  ),
  instructions: Type.Optional(
    Type.String({
      description:
        "Natural-language instructions used to narrow the crawl target.",
    }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Regular expression patterns used to limit crawled URL paths.",
    }),
  ),
  extract_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "Extraction depth for each page. Defaults to basic.",
    }),
  ),
});

type TavilyCrawlResult = {
  url: string;
  raw_content?: string;
};

type TavilyCrawlResponse = {
  base_url?: string;
  results?: TavilyCrawlResult[];
};

export const tavilyCrawlTool: AgentTool<typeof crawlParams> = {
  name: "tavily-crawl",
  label: "Tavily Crawl",
  description:
    "Crawl pages within a site starting from a specified URL and extract the content of each page.",
  parameters: crawlParams,
  execute: async (
    _toolCallId,
    {
      url,
      max_depth,
      max_breadth,
      limit,
      instructions,
      select_paths,
      extract_depth,
    },
  ) => {
    const baseUrl = resolveProxyBaseUrl("tavily");
    const res = await fetch(`${baseUrl}/crawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        max_depth,
        max_breadth,
        limit,
        instructions,
        select_paths,
        extract_depth,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily API エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as TavilyCrawlResponse;
    const results = data.results ?? [];

    const lines: string[] = [`# クロール結果: ${data.base_url ?? url}`, ""];
    for (const r of results) {
      lines.push(`## ${r.url}`, "", r.raw_content ?? "(本文なし)", "");
    }
    if (results.length === 0) lines.push("(結果なし)");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { url, resultCount: results.length },
    };
  },
};

const mapParams = Type.Object({
  url: Type.String({ description: "Base URL where mapping should start." }),
  max_depth: Type.Optional(
    Type.Integer({
      description: "Mapping depth from 1 to 5. Defaults to 1.",
      minimum: 1,
      maximum: 5,
    }),
  ),
  max_breadth: Type.Optional(
    Type.Integer({
      description:
        "Number of links to follow per page, from 1 to 500. Defaults to 20.",
      minimum: 1,
      maximum: 500,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "Maximum total number of URLs to process. Defaults to 50.",
      minimum: 1,
    }),
  ),
  instructions: Type.Optional(
    Type.String({
      description:
        "Natural-language instructions used to narrow the mapping target. Using this option doubles the cost.",
    }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regular expression patterns used to limit URL paths.",
    }),
  ),
  select_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "Regular expression patterns used to limit URL domains.",
    }),
  ),
});

type TavilyMapResponse = {
  base_url?: string;
  results?: string[];
};

export const tavilyMapTool: AgentTool<typeof mapParams> = {
  name: "tavily-map",
  label: "Tavily Map",
  description:
    "Map a site's URL structure and return the URLs without fetching page content.",
  parameters: mapParams,
  execute: async (
    _toolCallId,
    {
      url,
      max_depth,
      max_breadth,
      limit,
      instructions,
      select_paths,
      select_domains,
    },
  ) => {
    const baseUrl = resolveProxyBaseUrl("tavily");
    const res = await fetch(`${baseUrl}/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        max_depth,
        max_breadth,
        limit,
        instructions,
        select_paths,
        select_domains,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily API エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as TavilyMapResponse;
    const results = data.results ?? [];

    const lines: string[] = [`# サイトマップ: ${data.base_url ?? url}`, ""];
    for (const u of results) lines.push(`- ${u}`);
    if (results.length === 0) lines.push("(結果なし)");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { url, resultCount: results.length },
    };
  },
};
