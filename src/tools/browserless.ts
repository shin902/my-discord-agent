import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { resolveProxyBaseUrl } from "./proxy-url.js";

async function post(path: string, body: unknown): Promise<string> {
  const baseUrl = resolveProxyBaseUrl("browserless");
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`browserless エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return JSON.stringify(await res.json(), null, 2);
  }
  return res.text();
}

const smartScrapeParams = Type.Object({
  url: Type.String({ description: "スクレイプする URL" }),
  formats: Type.Optional(
    Type.Array(Type.String(), {
      description:
        '取得形式（html / markdown / screenshot / pdf / links、デフォルト: ["markdown"]）',
    }),
  ),
});

export const browserlessSmartScrapeTool: AgentTool<typeof smartScrapeParams> = {
  name: "browserless-smart-scrape",
  label: "Browserless Smart Scrape",
  description:
    "URL からコンテンツをスクレイプする。JS 描画・ブロック回避の自動フォールバック付き → JSON。⚠️出力が数万トークン級になりうるため、コンテキストの小さいモデル（ローカルLLM等）では使用禁止",
  parameters: smartScrapeParams,
  execute: async (_id, { url, formats }) => {
    const text = await post("/smart-scrape", {
      url,
      formats: formats ?? ["markdown"],
    });
    return { content: [{ type: "text", text }], details: { url } };
  },
};

const searchParams = Type.Object({
  query: Type.String({ description: "検索クエリ" }),
  limit: Type.Optional(
    Type.Number({
      description: "最大件数（デフォルト: 3、最大: 3）",
      minimum: 1,
      maximum: 3,
    }),
  ),
  lang: Type.Optional(
    Type.String({ description: "言語コード（デフォルト: ja）" }),
  ),
  sources: Type.Optional(
    Type.Array(Type.String(), {
      description: '検索ソース（web / news / images、デフォルト: ["web"]）',
    }),
  ),
});

export const browserlessSearchTool: AgentTool<typeof searchParams> = {
  name: "browserless-search",
  label: "Browserless Search",
  description: "ウェブ検索を実行して結果を返す → JSON",
  parameters: searchParams,
  execute: async (_id, { query, limit, lang, sources }) => {
    const text = await post("/search", {
      query,
      limit: Math.min(limit ?? 3, 3),
      lang: lang ?? "ja",
      sources: sources ?? ["web"],
    });
    return { content: [{ type: "text", text }], details: { query } };
  },
};

const functionParams = Type.Object({
  code: Type.String({
    description:
      "実行する Puppeteer コード（export default async ({page}) => {...} 形式）",
  }),
  context: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "コードに渡す追加コンテキスト",
    }),
  ),
});

export const browserlessFunctionTool: AgentTool<typeof functionParams> = {
  name: "browserless-function",
  label: "Browserless Function",
  description: "Puppeteer コードをブラウザで実行 → JSON",
  parameters: functionParams,
  execute: async (_id, { code, context }) => {
    const text = await post("/function", { code, context });
    return {
      content: [{ type: "text", text }],
      details: { codeLength: code.length },
    };
  },
};

const contentParams = Type.Object({
  url: Type.String({ description: "HTML を取得する URL" }),
});

export const browserlessContentTool: AgentTool<typeof contentParams> = {
  name: "browserless-content",
  label: "Browserless Content",
  description:
    "JavaScript 描画後の HTML 全文を取得 → HTML 文字列。⚠️出力が数万トークン級になりうるため、コンテキストの小さいモデル（ローカルLLM等）では使用禁止",
  parameters: contentParams,
  execute: async (_id, { url }) => {
    const html = await post("/content", { url });
    return { content: [{ type: "text", text: html }], details: { url } };
  },
};
