import { z } from "zod";
import { backupXSavedDatabase } from "../../integrations/x-saved/store.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const SettingsSchema = z.strictObject({
  keep: z.number().int().positive().max(365).optional(),
});

export default async function handler(ctx: CronContext): Promise<void> {
  const parsed = SettingsSchema.safeParse(ctx.settings ?? {});
  if (!parsed.success) {
    throw new NonRetryableError(
      `[x-saved-backup] settings error: ${parsed.error.message}`,
    );
  }

  const backupPath =
    parsed.data.keep === undefined
      ? await backupXSavedDatabase()
      : await backupXSavedDatabase(undefined, parsed.data.keep);
  console.log(`[x-saved-backup] backup: ${backupPath}`);
}
