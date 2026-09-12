import { z } from "zod";
import { loadRawCron } from "../config/config.js";
import {
  MemoryCoreError,
  parseMemoryCoreConnectionSettings,
} from "./memory-core.js";

const MemoryExportJobSchema = z.object({
  handler: z.literal("jobs/memory-export.ts"),
  settings: z.object({ type: z.literal("tencentdb") }).passthrough(),
});

export async function loadMemoryCoreConnectionSettingsFromCron() {
  const raw = await loadRawCron();
  if (!Array.isArray(raw)) {
    throw new MemoryCoreError("Invalid cron configuration", false);
  }
  const matches = raw.flatMap((value) => {
    const parsed = MemoryExportJobSchema.safeParse(value);
    return parsed.success ? [parsed.data.settings] : [];
  });
  if (matches.length !== 1) {
    throw new MemoryCoreError(
      "Expected exactly one TencentDB memory-export cron job",
      false,
    );
  }
  return parseMemoryCoreConnectionSettings(matches[0]);
}
