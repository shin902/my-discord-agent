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
