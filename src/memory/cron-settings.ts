import { z } from "zod";
import { loadRawCron } from "../config/config.js";
import { isCronHandler } from "../cron/handler-loader.js";
import { MEMORY_EXPORT_HANDLER } from "./export.js";
import {
  MemoryCoreError,
  parseMemoryCoreConnectionSettings,
} from "./memory-core.js";

const MemoryExportJobSchema = z.object({
  handler: z.string(),
  settings: z.object({ type: z.literal("tencentdb") }).passthrough(),
});

export async function loadMemoryCoreConnectionSettingsFromCron() {
  const raw = await loadRawCron();
  if (!Array.isArray(raw)) {
    throw new MemoryCoreError("Invalid cron configuration", false);
  }
  const candidates = raw.flatMap((value) => {
    const parsed = MemoryExportJobSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
  const identities = await Promise.all(
    candidates.map((job) => isCronHandler(job, MEMORY_EXPORT_HANDLER)),
  );
  const matches = candidates
    .filter((_, index) => identities[index])
    .map((job) => job.settings);
  if (matches.length !== 1) {
    throw new MemoryCoreError(
      "Expected exactly one TencentDB memory-export cron job",
      false,
    );
  }
  return parseMemoryCoreConnectionSettings(matches[0]);
}
