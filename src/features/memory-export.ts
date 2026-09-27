import { z } from "zod";
import { getCachedCronJob, isCronHandler } from "../cron/runner.js";
import { MEMORY_EXPORT_HANDLER, runMemoryExport } from "../memory/export.js";
import type { JobHandlers } from "../queue/job-handlers.js";
import type { InboxMessage } from "../queue/types.js";

const input = z.object({ cronJobId: z.string().min(1).optional() });

export function registerMemoryExport(handlers: JobHandlers): void {
  handlers.register("memory-export", async (message: InboxMessage, signal) => {
    const parsed = input.safeParse(message);
    if (!parsed.success) return; // Invalid cron identities terminally no-op.
    const job = parsed.data.cronJobId
      ? getCachedCronJob(parsed.data.cronJobId)
      : undefined;
    if (job?.enabled && (await isCronHandler(job, MEMORY_EXPORT_HANDLER))) {
      await runMemoryExport(job.id, job.settings, signal);
    }
    // Removed, disabled or repurposed cron identities terminally no-op.
  });
}
