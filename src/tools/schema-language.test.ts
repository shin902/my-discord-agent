import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { createBotTool } from "../sandbox/bot.js";
import { createSubagentTool } from "../sandbox/subagent.js";
import { resolveTools } from "./registry.js";

const STATIC_TOOL_NAMES = [
  "bash",
  "date",
  "agent-reach",
  "arxiv-search",
  "arxiv-survey",
  "read",
  "write",
  "list",
  "edit",
  "glob",
  "grep",
  "list-emails",
  "read-email",
  "list-issues",
  "read-issue",
  "list-issue-comments",
  "list-pull-request-comments",
  "read-pull-request",
  "comment-issue",
  "clone-repository",
  "list-calendars",
  "list-events",
  "read-event",
  "create-event",
  "update-event",
  "delete-event",
  "browserless-smart-scrape",
  "browserless-search",
  "browserless-function",
  "browserless-content",
  "tavily-search",
  "tavily-extract",
  "tavily-crawl",
  "tavily-map",
  "get-current-weather",
  "get-weather-forecast",
] as const;

const JAPANESE_TEXT = /[\u3040-\u30ff\u3400-\u9fff]/u;

function schemaDescriptions(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(schemaDescriptions);
  if (typeof value !== "object" || value === null) return [];

  const record = value as Record<string, unknown>;
  const descriptions =
    typeof record.description === "string" ? [record.description] : [];
  for (const [key, child] of Object.entries(record)) {
    if (key !== "description") descriptions.push(...schemaDescriptions(child));
  }
  return descriptions;
}

function expectModelFacingDescriptionsInEnglish(tool: AgentTool): void {
  const descriptions = [
    tool.description,
    ...schemaDescriptions(tool.parameters),
  ];
  expect(
    descriptions.filter((description) => JAPANESE_TEXT.test(description)),
  ).toEqual([]);
}

describe("model-facing tool schema language", () => {
  it("publishes registered built-in tool descriptions in English", () => {
    for (const name of STATIC_TOOL_NAMES) {
      const [tool] = resolveTools([name]);
      expectModelFacingDescriptionsInEnglish(tool);
    }
  });

  it("publishes context-created Bot and Subagent descriptions in English", () => {
    expectModelFacingDescriptionsInEnglish(createBotTool({} as never));
    expectModelFacingDescriptionsInEnglish(createSubagentTool({} as never));
  });
});
