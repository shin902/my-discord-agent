import { proxyCapabilityNames } from "./registry.js";

/** Built-in, reviewed dependencies. Skill files describe usage, never authority. */
export const SKILL_CAPABILITIES = {
  "agent-reach": ["agent-reach"],
  "tavily-search": ["tavily-search"],
  arxiv: ["arxiv-search", "arxiv-survey"],
  github: [
    "list-issues",
    "read-issue",
    "read-pull-request",
    "list-issue-comments",
    "list-pull-request-comments",
  ],
  "github-write": ["comment-issue"],
  calendar: [
    "list-calendars",
    "list-events",
    "read-event",
    "create-event",
    "update-event",
    "delete-event",
  ],
  mail: ["list-emails", "read-email"],
  weather: ["get-current-weather", "get-weather-forecast"],
  // Finance is deliberately absent: these are sandbox-local tools and the
  // Skill frontend invokes their image-owned local CLI directly.
  last30days: ["hackernews-search", "github-recent-search", "agent-reach"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export function runCapabilityNames(config: {
  tools?: readonly string[];
  skills?: readonly string[] | "*";
}): string[] {
  const skills =
    config.skills === "*"
      ? Object.keys(SKILL_CAPABILITIES)
      : (config.skills ?? []);
  return [
    ...new Set([
      ...proxyCapabilityNames([...(config.tools ?? [])]),
      ...skills.flatMap((skill) =>
        Object.hasOwn(SKILL_CAPABILITIES, skill)
          ? SKILL_CAPABILITIES[skill as keyof typeof SKILL_CAPABILITIES]
          : [],
      ),
    ]),
  ];
}
