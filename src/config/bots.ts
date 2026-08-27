import { z } from "zod";
import { loadRawConfig } from "./config.js";
import { AgentConfigSchema } from "./groups.js";

/** A persistent worker profile scoped to an AgentGroup. */
export const BotProfileSchema = AgentConfigSchema.extend({
  group: z.string().min(1),
  instructions: z.string().min(1),
});

export type BotProfile = z.infer<typeof BotProfileSchema>;

/** Named Bot profiles declared in the top-level config.json `bots` map. */
export const BotRegistrySchema = z
  .record(z.string().min(1), BotProfileSchema)
  .default({});

export type BotRegistry = z.infer<typeof BotRegistrySchema>;

export async function loadBotRegistry(): Promise<BotRegistry> {
  const raw = await loadRawConfig();
  return BotRegistrySchema.parse(raw.bots);
}
