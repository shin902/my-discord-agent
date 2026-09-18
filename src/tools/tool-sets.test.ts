import { describe, expect, it } from "vitest";
import { getCapabilityDefinition, resolveTools } from "./registry.js";
import { runCapabilityNames, TOOL_SETS } from "./tool-sets.js";

describe("trusted toolSets", () => {
  it.each(
    Object.entries(TOOL_SETS),
  )("grants %s without Skills or native schemas", (name, expected) => {
    const config = { tools: ["read"], skills: [], toolSets: [name] };
    expect(runCapabilityNames(config)).toEqual(expected);
    expect(resolveTools(config.tools).map((tool) => tool.name)).toEqual([
      "read",
    ]);
    for (const capability of expected) {
      expect(["host", "runtime"]).toContain(
        getCapabilityDefinition(capability)?.executor,
      );
    }
  });

  it("never grants authority from Skill names, including legacy and custom Skills", () => {
    const config = {
      tools: ["bash"],
      skills: [
        ...Object.keys(TOOL_SETS),
        "last30days",
        "agent-reach",
        "arxiv-search",
        "arxiv-survey",
        "custom",
      ],
    };
    expect(runCapabilityNames(config)).toEqual([]);
    expect(runCapabilityNames({ ...config, toolSets: [] })).toEqual([]);
  });

  it("unions native Proxy capabilities and Skill permissions without duplicates", () => {
    expect(
      runCapabilityNames({
        tools: ["bash", "agent-reach", "read-email"],
        toolSets: ["agent-reach", "web", "mail", "web"],
      }),
    ).toEqual([
      "agent-reach",
      "read-email",
      "tavily-search",
      "arxiv-search",
      "arxiv-survey",
      "hackernews-search",
      "github-recent-search",
      "x-search",
      "list-emails",
    ]);
  });

  it.each([
    "*",
    "unknown",
    "__proto__",
    "constructor",
  ])("rejects unknown permission set %s", (name) => {
    expect(() => runCapabilityNames({ toolSets: [name] })).toThrow(
      `Unknown toolSet: ${name}`,
    );
  });
});
