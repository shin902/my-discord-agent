import type { CronContext } from "../runner.js";

/** Cron only admits work; the runtime queue owns execution and recovery. */
export default async function memoryExport(ctx: CronContext): Promise<void> {
  await ctx.appendInbox({
    jobKind: "memory-export",
    cronJobId: ctx.id,
    timestamp: new Date().toISOString(),
  });
}
