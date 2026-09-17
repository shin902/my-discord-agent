import { describe, expect, it } from "vitest";
import { resolveTools } from "./registry.js";
import { runCapabilityNames } from "./skill-capabilities.js";

describe("trusted Skill dependencies", () => {
  it.each([
    [{ tools: ["agent-reach"], skills: [] }, ["agent-reach"]],
    [
      { tools: ["bash"], skills: ["web"] },
      [
        "agent-reach",
        "tavily-search",
        "arxiv-search",
        "arxiv-survey",
        "hackernews-search",
        "github-recent-search",
        "x-search",
      ],
    ],
    [
      { tools: ["agent-reach"], skills: ["web"] },
      [
        "agent-reach",
        "tavily-search",
        "arxiv-search",
        "arxiv-survey",
        "hackernews-search",
        "github-recent-search",
        "x-search",
      ],
    ],
    [
      { tools: [], skills: ["github"] },
      [
        "list-issues",
        "read-issue",
        "read-pull-request",
        "list-issue-comments",
        "list-pull-request-comments",
        "comment-issue",
      ],
    ],
    [{ tools: [], skills: ["mail"] }, ["list-emails", "read-email"]],
    [
      { tools: [], skills: ["calendar"] },
      [
        "list-calendars",
        "list-events",
        "read-event",
        "create-event",
        "update-event",
        "delete-event",
      ],
    ],
    [
      { tools: [], skills: ["weather"] },
      ["get-current-weather", "get-weather-forecast"],
    ],
    [{ tools: ["read"], skills: [] }, []],
    [
      { tools: [], skills: ["last30days"] },
      ["hackernews-search", "github-recent-search", "agent-reach"],
    ],
    [
      { tools: [], skills: ["untrusted-manifest", "__proto__", "constructor"] },
      [],
    ],
  ])("resolves only built-in dependencies: %j", (config, expected) => {
    expect(runCapabilityNames(config)).toEqual(expected);
  });
  it("does not add Skill dependencies to the model's native tool list", () => {
    const config = { tools: ["read"], skills: ["mail"] };
    expect(runCapabilityNames(config)).toEqual(["list-emails", "read-email"]);
    expect(resolveTools(config.tools).map((tool) => tool.name)).toEqual([
      "read",
    ]);
  });
});
