import { describe, expect, it } from "vitest";
import { resolveTools } from "./registry.js";
import { runCapabilityNames } from "./skill-capabilities.js";

describe("trusted Skill dependencies", () => {
  it.each([
    [{ tools: ["agent-reach"], skills: [] }, ["agent-reach"]],
    [{ tools: ["bash"], skills: ["agent-reach"] }, ["agent-reach"]],
    [{ tools: ["agent-reach"], skills: ["agent-reach"] }, ["agent-reach"]],
    [{ tools: ["read"], skills: [] }, []],
    [{ tools: [], skills: ["tavily-search"] }, ["tavily-search"]],
    [{ tools: [], skills: ["arxiv"] }, ["arxiv-search", "arxiv-survey"]],
    [
      { tools: [], skills: ["github"] },
      [
        "list-issues",
        "read-issue",
        "read-pull-request",
        "list-issue-comments",
        "list-pull-request-comments",
      ],
    ],
    [{ tools: [], skills: ["github-write"] }, ["comment-issue"]],
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
    [{ tools: [], skills: ["mail"] }, ["list-emails", "read-email"]],
    [
      { tools: [], skills: ["weather"] },
      ["get-current-weather", "get-weather-forecast"],
    ],
    [{ tools: [], skills: ["finance"] }, []],
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
  it("wildcard never grants unrelated host capabilities or local tools", () => {
    expect(runCapabilityNames({ skills: "*" })).toEqual([
      "agent-reach",
      "tavily-search",
      "arxiv-search",
      "arxiv-survey",
      "list-issues",
      "read-issue",
      "read-pull-request",
      "list-issue-comments",
      "list-pull-request-comments",
      "comment-issue",
      "list-calendars",
      "list-events",
      "read-event",
      "create-event",
      "update-event",
      "delete-event",
      "list-emails",
      "read-email",
      "get-current-weather",
      "get-weather-forecast",
      "hackernews-search",
      "github-recent-search",
    ]);
  });
  it("does not add Skill dependencies to the model's native tool list", () => {
    const config = { tools: ["read"], skills: ["arxiv"] };
    expect(runCapabilityNames(config)).toEqual([
      "arxiv-search",
      "arxiv-survey",
    ]);
    expect(resolveTools(config.tools).map((tool) => tool.name)).toEqual([
      "read",
    ]);
  });
});
