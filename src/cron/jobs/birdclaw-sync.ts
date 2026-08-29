import { z } from "zod";
import { runXSavedSync } from "../../integrations/x-saved/sync.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const SettingsSchema = z.object({
  mode: z.enum(["auto", "xurl", "bird"]).default("xurl"),
  limit: z.number().int().positive().max(1000).default(100),
  maxPages: z.number().int().positive().max(100).default(3),
  account: z.string().min(1).optional(),
  birdclawDbPath: z.string().min(1).optional(),
  xSavedDbPath: z.string().min(1).optional(),
  backupKeep: z.number().int().positive().max(365).default(14),
});

export default async function handler(ctx: CronContext): Promise<void> {
  let settings: z.infer<typeof SettingsSchema>;
  try {
    settings = SettingsSchema.parse(ctx.settings ?? {});
  } catch (error) {
    throw new NonRetryableError(
      `[birdclaw-sync] settings error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const result = await runXSavedSync(settings);
    const summary = {
      status: result.status,
      bookmarksFetched: result.bookmarksFetched,
      likesFetched: result.likesFetched,
      sourceItems: result.sourceItems,
      newItems: result.newItems,
      updatedItems: result.updatedItems,
      backupPath: result.backupPath,
      errors: result.errors,
    };
    if (result.status === "success") {
      console.log("[birdclaw-sync] completed", summary);
    } else {
      console.error("[birdclaw-sync] completed with errors", summary);
    }
  } catch (error) {
    // Do not throw operational BirdClaw/X failures into the generic cron retry
    // loop. The next scheduled run is the recovery boundary for this source.
    console.error(
      "[birdclaw-sync] failed; waiting for the next scheduled run:",
      error,
    );
  }
}
