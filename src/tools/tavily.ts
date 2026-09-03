import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { resolveBaseUrl } from "../agent/model.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { loadRequestTimeoutMs } from "../config/proxy-config.js";

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
      { description: "Search topic. Defaults to general." },
    ),
  ),
});

type TavilyResult = {
  title: string;
  url: string;
  content: string;
  score: number;
};
type TavilyResponse = { answer?: string; results: TavilyResult[] };

async function loadTavilyApiConfig(): Promise<{
  baseUrl: string;
  apiKey: string;
}> {
  const entry = (await loadCredentialProxy()).find(
    (candidate) => candidate.provider === "tavily",
  );
  if (!entry)
    throw new Error("tavily プロバイダーが credentials.json に見つかりません");
  const baseUrl = resolveBaseUrl(entry.baseUrl);
  if (!baseUrl)
    throw new Error("tavily の baseUrl に未解決のプレースホルダがあります");
  const apiKey = entry.envVars
    ?.map((envVar) => process.env[envVar])
    .find((value): value is string => Boolean(value));
  if (!apiKey)
    throw new Error(
      "tavily の envVars に設定された環境変数のいずれにも値がありません",
    );
  return { baseUrl, apiKey };
}

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
    signal,
  ) => {
    const { baseUrl, apiKey } = await loadTavilyApiConfig();
    const timeoutSignal = AbortSignal.timeout(await loadRequestTimeoutMs());
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let res: Response;
    try {
      res = await fetch(`${baseUrl.replace(/\/$/, "")}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          query,
          max_results: Math.min(max_results, 10),
          search_depth,
          include_answer,
          topic,
        }),
        signal: requestSignal,
      });
    } catch (error) {
      if (timeoutSignal.aborted && !signal?.aborted)
        throw new Error("upstream timeout for tavily");
      throw error;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Tavily API エラー ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as TavilyResponse;
    const results = data.results ?? [];
    const lines: string[] = [];
    if (data.answer) lines.push("## 回答", "", data.answer, "");
    lines.push("## 検索結果", "");
    for (const result of results) {
      lines.push(`### ${result.title ?? "(タイトルなし)"}`);
      if (result.url) lines.push(`- URL: ${result.url}`);
      if (typeof result.score === "number")
        lines.push(`- スコア: ${result.score.toFixed(2)}`);
      if (result.content) lines.push(`- ${result.content}`);
      lines.push("");
    }
    if (results.length === 0) lines.push("(結果なし)");
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { query, resultCount: results.length },
    };
  },
};
