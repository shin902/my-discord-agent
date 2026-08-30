import { z } from "zod";
import { runXSavedSync } from "../../integrations/x-saved/sync.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const SettingsSchema = z.strictObject({
  account: z.string().min(1).optional(),
  // Keep accepting settings from the pre-MVP cron configuration during rollout.
  mode: z.enum(["auto", "xurl", "bird"]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
  maxPages: z.number().int().positive().max(100).optional(),
  backupKeep: z.number().int().positive().max(365).optional(),
  backupPath: z.string().min(1).optional(),
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

  const result = await runXSavedSync(settings);
  const summary = {
    status: result.status,
    newItems: result.newItems,
    backupPath: result.backupPath,
    errors: result.errors,
  };
  if (result.status === "success") {
    console.log("[birdclaw-sync] completed", summary);
  } else {
    console.error("[birdclaw-sync] completed with errors", summary);
  }
}
