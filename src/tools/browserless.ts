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
  url: Type.String({ description: "URL to scrape." }),
  formats: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Output formats such as html, markdown, screenshot, pdf, or links. Defaults to ["markdown"].',
    }),
  ),
});

export const browserlessSmartScrapeTool: AgentTool<typeof smartScrapeParams> = {
  name: "browserless-smart-scrape",
  label: "Browserless Smart Scrape",
  description:
    "Scrape content from a URL with automatic fallbacks for JavaScript rendering and blocking, returning JSON. Output can reach tens of thousands of tokens, so do not use it with small-context models such as local LLMs.",
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
  query: Type.String({ description: "Search query." }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results. Defaults to 3; maximum 3.",
      minimum: 1,
      maximum: 3,
    }),
  ),
  lang: Type.Optional(
    Type.String({ description: "Language code. Defaults to ja." }),
  ),
  sources: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Search sources such as web, news, or images. Defaults to ["web"].',
    }),
  ),
});

export const browserlessSearchTool: AgentTool<typeof searchParams> = {
  name: "browserless-search",
  label: "Browserless Search",
  description: "Run a web search and return the results as JSON.",
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
      "Puppeteer code to execute in the form export default async ({page}) => {...}.",
  }),
  context: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Additional context passed to the code.",
    }),
  ),
});

export const browserlessFunctionTool: AgentTool<typeof functionParams> = {
  name: "browserless-function",
  label: "Browserless Function",
  description: "Run Puppeteer code in a browser and return JSON.",
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
  url: Type.String({
    description: "URL whose rendered HTML should be fetched.",
  }),
});

export const browserlessContentTool: AgentTool<typeof contentParams> = {
  name: "browserless-content",
  label: "Browserless Content",
  description:
    "Fetch the full HTML after JavaScript rendering. Output can reach tens of thousands of tokens, so do not use it with small-context models such as local LLMs.",
  parameters: contentParams,
  execute: async (_id, { url }) => {
    const html = await post("/content", { url });
    return { content: [{ type: "text", text: html }], details: { url } };
  },
};
