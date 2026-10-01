import { z } from "zod";
import { loadConfigField, loadRawConfig } from "../../config/config.js";

export const AgentMemorySettingsSchema = z.object({
  enabled: z.boolean(),
});

export type AgentMemorySettings = z.infer<typeof AgentMemorySettingsSchema>;

const AgentMemoryConfigSchema = z.object({
  threshold: z.number().min(0).max(1).optional(),
});

// Provisional: favor concrete usefulness over merely related topics; not calibrated.
export const DEFAULT_AGENT_MEMORY_THRESHOLD = 0.7;

export async function loadAgentMemoryThreshold(): Promise<number> {
  return loadConfigField(
    await loadRawConfig(),
    "agentMemory",
    AgentMemoryConfigSchema,
    "threshold",
    DEFAULT_AGENT_MEMORY_THRESHOLD,
  );
}
