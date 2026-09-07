import { describe, expect, it } from "vitest";
import { resolveTools } from "./registry.js";
import { runCapabilityNames } from "./skill-capabilities.js";

describe("trusted Skill dependencies", () => {
  it.each([
    [{ tools: ["agent-reach"], skills: [] }, ["agent-reach"]],
    [{ tools: ["bash"], skills: ["agent-reach"] }, ["agent-reach"]],
    [{ tools: ["agent-reach"], skills: ["agent-reach"] }, ["agent-reach"]],
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
  it("wildcard never grants unrelated host capabilities or local tools", () => {
    expect(runCapabilityNames({ skills: "*" })).toEqual([
      "agent-reach",
      "arxiv-search",
      "arxiv-survey",
      "hackernews-search",
      "github-recent-search",
    ]);
  });
  it("does not add Skill dependencies to the model's native tool list", () => {
    const config = { tools: ["read"], skills: ["arxiv-search"] };
    expect(runCapabilityNames(config)).toEqual(["arxiv-search"]);
    expect(resolveTools(config.tools).map((tool) => tool.name)).toEqual([
      "read",
    ]);
  });
});
