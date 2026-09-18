import { afterEach, describe, expect, it, vi } from "vitest";
import { materializeCapabilityArgs } from "./capability.js";
import {
  githubRecentSearchTool,
  hackerNewsSearchTool,
} from "./recent-search.js";
import { getRuntimeCapability } from "./runtime-capabilities.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("last30days fixed public search contracts", () => {
  it("freezes the 30-day cutoff before approval and removes caller-supplied execution fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T01:02:03Z"));
    const capability = getRuntimeCapability("hackernews-search");
    if (!capability) throw new Error("missing capability");
    const args = materializeCapabilityArgs(capability, {
      topic: "a & b",
      since: "1900-01-01",
      url: "http://private",
      headers: { Cookie: "secret" },
      image: "other",
    });
    expect(args).toEqual({ topic: "a & b", since: "2026-08-09T01:02:03Z" });
  });
  it("retains Algolia parameters and the story display format", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T01:02:03Z"));
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        hits: [
          {
            points: 42,
            title: "Story",
            url: "https://example.com",
            num_comments: 7,
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await hackerNewsSearchTool.execute("hn", { topic: "a & b" });
    const url = fetch.mock.calls[0][0] as URL;
    expect(url.origin + url.pathname).toBe(
      "https://hn.algolia.com/api/v1/search",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      query: "a & b",
      tags: "story",
      numericFilters: `created_at_i>${Date.parse("2026-08-09T01:02:03Z") / 1000}`,
      hitsPerPage: "10",
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: "[42pt] Story\n  https://example.com\n  comments: 7\n",
      },
    ]);
  });
  it("retains public GitHub Issues/PR search and reaction display without credentials", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-08T01:02:03Z"));
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        items: [
          {
            title: "Issue",
            html_url: "https://github.com/o/r/issues/1",
            reactions: { total_count: 9 },
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const result = await githubRecentSearchTool.execute("gh", {
      topic: "a & b",
    });
    const [url, options] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe(
      "https://api.github.com/search/issues",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "a & b updated:>2026-08-09T01:02:03Z",
      sort: "reactions",
      per_page: "5",
    });
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "[9👍] Issue\n  https://github.com/o/r/issues/1\n",
      },
    ]);
  });
  it("does not disguise source failures as successful empty results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 })),
    );
    await expect(
      hackerNewsSearchTool.execute("hn", { topic: "q" }),
    ).rejects.toThrow("HTTP 429");
  });
});
