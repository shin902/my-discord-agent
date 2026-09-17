import { proxyCapabilityNames } from "./registry.js";

/** Built-in, reviewed dependencies. Skill files describe usage, never authority. */
const SKILL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
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
  // Existing deployed groups are not overwritten when templates change.
  "agent-reach": ["agent-reach"],
  "arxiv-search": ["arxiv-search"],
  "arxiv-survey": ["arxiv-survey"],
  last30days: ["hackernews-search", "github-recent-search", "agent-reach"],
};

export function runCapabilityNames(config: {
  tools?: readonly string[];
  skills?: readonly string[];
}): string[] {
  const skills = config.skills ?? [];
  return [
    ...new Set([
      ...proxyCapabilityNames([...(config.tools ?? [])]),
      ...skills.flatMap((skill) =>
        Object.hasOwn(SKILL_CAPABILITIES, skill)
          ? SKILL_CAPABILITIES[skill]
          : [],
      ),
    ]),
  ];
}
