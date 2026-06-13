import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const searchParams = Type.Object({
  query: Type.String({ description: "検索クエリ" }),
  max_results: Type.Optional(
    Type.Integer({
      description: "最大件数（デフォルト: 5、最大: 10）",
      minimum: 1,
      maximum: 10,
    }),
  ),
  search_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description:
        "検索の深さ（basic: 高速、advanced: 詳細だが低速。デフォルト: basic）",
    }),
  ),
  include_answer: Type.Optional(
    Type.Boolean({
      description: "AIによる要約回答を含めるか（デフォルト: true）",
    }),
  ),
  topic: Type.Optional(
    Type.Union(
      [Type.Literal("general"), Type.Literal("news"), Type.Literal("finance")],
      {
        description: "検索トピック（デフォルト: general）",
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
  name: "tavily_search",
  label: "Tavily Search",
  description:
    "ウェブ検索を実行して結果を返す。最新の情報やファクトチェックに使う",
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
  urls: Type.Array(Type.String(), { description: "本文を抽出するURLの一覧" }),
  extract_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description:
        "抽出の深さ（basic: 高速、advanced: 詳細だが低速。デフォルト: basic）",
    }),
  ),
  include_images: Type.Optional(
    Type.Boolean({ description: "画像URLを含めるか（デフォルト: false）" }),
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
  name: "tavily_extract",
  label: "Tavily Extract",
  description:
    "⚠️ローカルLLM禁止（コンテキスト爆発リスク）: 指定したURLのページ本文を抽出する。検索結果のページを詳しく読むときに使う",
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
  url: Type.String({ description: "クロールを開始するルートURL" }),
  max_depth: Type.Optional(
    Type.Integer({
      description: "クロールする深さ（1〜5、デフォルト: 1）",
      minimum: 1,
      maximum: 5,
    }),
  ),
  max_breadth: Type.Optional(
    Type.Integer({
      description: "1ページあたりにたどるリンク数（1〜500、デフォルト: 20）",
      minimum: 1,
      maximum: 500,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "処理するページ総数の上限（デフォルト: 50）",
      minimum: 1,
    }),
  ),
  instructions: Type.Optional(
    Type.String({ description: "クロール対象を絞り込む自然言語の指示" }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "クロール対象URLを絞り込むパスの正規表現パターン",
    }),
  ),
  extract_depth: Type.Optional(
    Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
      description: "各ページの抽出の深さ（デフォルト: basic）",
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
  name: "tavily_crawl",
  label: "Tavily Crawl",
  description:
    "⚠️ローカルLLM禁止（コンテキスト爆発リスク）: 指定URLを起点にサイト内のページをクロールし、各ページの本文を取得する",
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
  url: Type.String({ description: "マッピングを開始するベースURL" }),
  max_depth: Type.Optional(
    Type.Integer({
      description: "マッピングする深さ（1〜5、デフォルト: 1）",
      minimum: 1,
      maximum: 5,
    }),
  ),
  max_breadth: Type.Optional(
    Type.Integer({
      description: "1ページあたりにたどるリンク数（1〜500、デフォルト: 20）",
      minimum: 1,
      maximum: 500,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: "処理するURL総数の上限（デフォルト: 50）",
      minimum: 1,
    }),
  ),
  instructions: Type.Optional(
    Type.String({
      description: "マッピング対象を絞り込む自然言語の指示（指定するとコスト2倍）",
    }),
  ),
  select_paths: Type.Optional(
    Type.Array(Type.String(), {
      description: "対象URLを絞り込むパスの正規表現パターン",
    }),
  ),
  select_domains: Type.Optional(
    Type.Array(Type.String(), {
      description: "対象URLを絞り込むドメインの正規表現パターン",
    }),
  ),
});

type TavilyMapResponse = {
  base_url?: string;
  results?: string[];
};

export const tavilyMapTool: AgentTool<typeof mapParams> = {
  name: "tavily_map",
  label: "Tavily Map",
  description:
    "サイト内のURL構造をマッピングして一覧を取得する（ページ本文は取得しない）",
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
