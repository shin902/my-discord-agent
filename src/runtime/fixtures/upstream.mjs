// Test-image-only upstream fixtures. The production image never imports this.
import dns from "node:dns/promises";
import { readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { chromium } from "/app/node_modules/playwright/index.mjs";

dns.lookup = async (_hostname, options) =>
  options?.all
    ? [{ address: "93.184.216.34", family: 4 }]
    : { address: "93.184.216.34", family: 4 };
syncBuiltinESMExports();
const atom = await readFile("/fixture/arxiv.xml", "utf8");
globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  if (url.hostname === "export.arxiv.org")
    return new Response(atom, {
      headers: { "content-type": "application/atom+xml" },
    });
  if (url.hostname === "hn.algolia.com") {
    if (url.searchParams.get("query") === "identity") {
      const status = await readFile("/proc/self/status", "utf8");
      return Response.json({
        hits: [
          {
            title: `uid=${process.getuid()} ${status.match(/CapEff:\s+\w+/)?.[0]}`,
            points: 1,
            num_comments: 0,
          },
        ],
      });
    }
    return Response.json({
      hits: [
        {
          title: "Runtime HN fixture",
          points: 42,
          num_comments: 7,
          url: "https://example.com/hn",
        },
      ],
    });
  }
  if (url.hostname === "api.github.com")
    return Response.json({
      items: [
        {
          title: "Runtime issue fixture",
          html_url: "https://github.com/o/r/issues/1",
          reactions: { total_count: 9 },
        },
      ],
    });
  if (url.hostname.endsWith("reddit.com")) {
    const headers = new Headers(options.headers);
    if (headers.get("cookie") !== "fixture=only")
      throw new Error("Fixture Cookie was not supplied");
    return Response.json({
      data: {
        children: [
          {
            data: {
              title: "Runtime Reddit fixture",
              subreddit: "fixture",
              author: "fixture",
              score: 3,
              num_comments: 2,
              permalink: "/r/fixture/comments/1/fixture/",
              selftext: "Fixture body",
            },
          },
        ],
      },
    });
  }
  throw new Error(`Unexpected fixture upstream: ${url.hostname}`);
};
chromium.launchPersistentContext = async (profileDir) => {
  await writeFile(`${profileDir}/fixture-refreshed`, "refreshed");
  return {
    newPage: async () => ({
      goto: async () => {},
      waitForTimeout: async () => {},
      url: () => "https://www.reddit.com/",
    }),
    cookies: async () => [{ name: "fixture", value: "only" }],
    close: async () => {},
  };
};
