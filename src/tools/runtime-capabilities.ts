import type { AgentTool } from "@earendil-works/pi-agent-core";
import { agentReachTool, detectService, normalizeUrl } from "./agent-reach.js";
import { arxivSearchTool, arxivSurveyTool } from "./arxiv.js";
import {
  type CapabilityDefinition,
  materializeToolArgs,
  validateToolArgs,
} from "./capability.js";
import {
  githubRecentSearchTool,
  hackerNewsSearchTool,
  recentSearchSince,
} from "./recent-search.js";

type RuntimeCapability = Extract<
  CapabilityDefinition,
  { executor: "host" | "runtime" }
> & {
  readonly executor: "runtime";
  readonly timeoutMs: number;
  readonly needsRedditCookies?: (args: unknown) => boolean;
};

function runtimeCapability(
  tool: AgentTool,
  options: {
    timeoutMs: number;
    clampedProperties?: readonly string[];
    defaultArgs?: () => Readonly<Record<string, unknown>>;
    needsRedditCookies?: (args: unknown) => boolean;
  },
): RuntimeCapability {
  return {
    tool: tool.name,
    executor: "runtime",
    factory: () => tool,
    timeoutMs: options.timeoutMs,
    needsRedditCookies: options.needsRedditCookies,
    validateArgs: validateToolArgs(tool, options.clampedProperties),
    materializeArgs: materializeToolArgs(tool, options),
  };
}

/** The single trusted definition set shared by host Registry and Runtime dispatch. */
export const RUNTIME_CAPABILITIES = {
  "agent-reach": runtimeCapability(agentReachTool, {
    timeoutMs: 120_000,
    needsRedditCookies: (args) =>
      detectService(new URL(normalizeUrl((args as { url: string }).url))) ===
      "reddit",
  }),
  "arxiv-search": runtimeCapability(arxivSearchTool, {
    timeoutMs: 30_000,
    clampedProperties: ["max_results"],
    defaultArgs: () => ({ max_results: 10, sort: "relevance" }),
  }),
  "arxiv-survey": runtimeCapability(arxivSurveyTool, {
    timeoutMs: 30_000,
    clampedProperties: ["max_results"],
    defaultArgs: () => ({ max_results: 30, sort: "submitted" }),
  }),
  "hackernews-search": runtimeCapability(hackerNewsSearchTool, {
    timeoutMs: 30_000,
    defaultArgs: () => ({ since: recentSearchSince() }),
  }),
  "github-recent-search": runtimeCapability(githubRecentSearchTool, {
    timeoutMs: 30_000,
    defaultArgs: () => ({ since: recentSearchSince() }),
  }),
} satisfies Record<string, RuntimeCapability>;

export function getRuntimeCapability(
  name: string,
): RuntimeCapability | undefined {
  return Object.hasOwn(RUNTIME_CAPABILITIES, name)
    ? RUNTIME_CAPABILITIES[name as keyof typeof RUNTIME_CAPABILITIES]
    : undefined;
}
