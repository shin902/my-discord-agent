import { proxyCapabilityNames } from "./registry.js";

/** Built-in, reviewed dependencies. Skill files describe usage, never authority. */
const SKILL_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
  "agent-reach": ["agent-reach"],
  "arxiv-search": ["arxiv-search"],
  "arxiv-survey": ["arxiv-survey"],
  last30days: ["hackernews-search", "github-recent-search", "agent-reach"],
};

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
          ? SKILL_CAPABILITIES[skill]
          : [],
      ),
    ]),
  ];
}
