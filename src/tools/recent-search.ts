import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { readLimitedJson } from "./agent-reach.js";

const parameters = Type.Object({
  topic: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Topic to search during the last 30 days.",
  }),
});

export function recentSearchSince(): string {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
}

async function search(url: URL, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json, application/json",
      "User-Agent": "my-discord-agent/last30days",
    },
    redirect: "error",
    signal: AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Search API failed (HTTP ${response.status})`);
  }
  return readLimitedJson(response, 5 * 1024 * 1024);
}

// Both entry points use this fixed API contract. There is no arbitrary URL,
// header, credentials, or executable input.
export const hackerNewsSearchTool: AgentTool<typeof parameters> = {
  name: "hackernews-search",
  label: "HackerNews Search",
  description:
    "Search HackerNews stories from the last 30 days, returning up to 10 stories with points and comment counts.",
  parameters,
  execute: async (_id, args, signal) => {
    const { topic } = args;
    const since = (args as { since?: string }).since ?? recentSearchSince();
    const url = new URL("https://hn.algolia.com/api/v1/search");
    url.search = new URLSearchParams({
      query: topic,
      tags: "story",
      numericFilters: `created_at_i>${Math.floor(Date.parse(since) / 1000)}`,
      hitsPerPage: "10",
    }).toString();
    const data = (await search(url, signal)) as {
      hits?: {
        points?: number;
        title: string;
        url?: string;
        num_comments?: number;
      }[];
    };
    return {
      content: [
        {
          type: "text",
          text: (data.hits ?? [])
            .map(
              (h) =>
                `[${h.points ?? 0}pt] ${h.title}\n  ${h.url ?? ""}\n  comments: ${h.num_comments ?? 0}\n`,
            )
            .join(""),
        },
      ],
      details: { topic, since },
    };
  },
};

export const githubRecentSearchTool: AgentTool<typeof parameters> = {
  name: "github-recent-search",
  label: "GitHub Recent Search",
  description:
    "Search public GitHub Issues and PRs updated during the last 30 days, returning up to 5 results sorted by reactions.",
  parameters: hackerNewsSearchTool.parameters,
  execute: async (_id, args, signal) => {
    const { topic } = args;
    const since = (args as { since?: string }).since ?? recentSearchSince();
    const url = new URL("https://api.github.com/search/issues");
    url.search = new URLSearchParams({
      q: `${topic} updated:>${since}`,
      sort: "reactions",
      per_page: "5",
    }).toString();
    const data = (await search(url, signal)) as {
      items?: {
        reactions?: { total_count?: number };
        title: string;
        html_url: string;
      }[];
    };
    return {
      content: [
        {
          type: "text",
          text: (data.items ?? [])
            .map(
              (i) =>
                `[${i.reactions?.total_count ?? 0}👍] ${i.title}\n  ${i.html_url}\n`,
            )
            .join(""),
        },
      ],
      details: { topic, since },
    };
  },
};
