import type { AgentConfig } from "./groups.js";

/** AgentConfig fields that may be overridden at each trusted configuration layer. */
export const AGENT_CONFIG_FIELDS = [
  "model",
  "tools",
  "skills",
  "mounts",
] as const satisfies readonly (keyof AgentConfig)[];

/** Pick only common AgentConfig fields from a group, channel, or job config. */
export function pickAgentConfig(
  source: Partial<AgentConfig> | undefined,
): Partial<AgentConfig> {
  const picked: Partial<AgentConfig> = {};
  for (const field of AGENT_CONFIG_FIELDS) {
    const value = source?.[field];
    if (value !== undefined) Object.assign(picked, { [field]: value });
  }
  return picked;
}

/**
 * Resolve trusted AgentConfig layers from parent to child.
 *
 * Each field is assigned as a whole when present. In particular, model objects
 * and array fields are replaced rather than recursively merged or appended.
 */
export function resolveAgentConfig(
  ...layers: Array<Partial<AgentConfig> | undefined>
): AgentConfig {
  const resolved: AgentConfig = {};
  for (const layer of layers) {
    Object.assign(resolved, pickAgentConfig(layer));
  }
  return resolved;
}
