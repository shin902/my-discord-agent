import { proxyCapabilityNames } from "./registry.js";

/** Trusted capabilities available to each Skill. Skill files never grant authority. */
export const TOOL_SETS: Readonly<Record<string, readonly string[]>> = {
  "agent-reach": ["agent-reach"],
  "arxiv-search": ["arxiv-search"],
  "arxiv-survey": ["arxiv-survey"],
  last30days: ["hackernews-search", "github-recent-search", "agent-reach"],
  web: [
    "agent-reach",
    "tavily-search",
    "arxiv-search",
    "arxiv-survey",
    "hackernews-search",
    "github-recent-search",
    "x-search",
  ],
  github: [
    "list-issues",
    "read-issue",
    "read-pull-request",
    "list-issue-comments",
    "list-pull-request-comments",
    "comment-issue",
  ],
  mail: ["list-emails", "read-email"],
  calendar: [
    "list-calendars",
    "list-events",
    "read-event",
    "create-event",
    "update-event",
    "delete-event",
  ],
  weather: ["get-current-weather", "get-weather-forecast"],
};

export function runCapabilityNames(config: {
  tools?: readonly string[];
  toolSets?: readonly string[];
}): string[] {
  return [
    ...new Set([
      ...proxyCapabilityNames([...(config.tools ?? [])]),
      ...(config.toolSets ?? []).flatMap((name) => {
        if (!Object.hasOwn(TOOL_SETS, name)) {
          throw new Error(`Unknown toolSet: ${name}`);
        }
        return TOOL_SETS[name];
      }),
    ]),
  ];
}
