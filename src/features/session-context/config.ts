import { z } from "zod";
import { loadRawConfig } from "../../config/config.js";

export const CompactionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().gt(0).lt(1).default(0.7),
  keepRecentTokens: z.number().int().positive().default(20_000),
});

export type CompactionConfig = z.infer<typeof CompactionConfigSchema>;

export async function loadCompactionConfig(): Promise<CompactionConfig> {
  const raw = await loadRawConfig();
  return CompactionConfigSchema.parse(
    raw.compaction === undefined ? {} : raw.compaction,
  );
}
