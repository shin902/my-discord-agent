import type { CronContext } from "../runner.js";

/** Cron only admits work; the runtime queue owns execution and recovery. */
export default async function memoryExport(ctx: CronContext): Promise<void> {
  await ctx.appendInbox({
    jobKind: "memory-export",
    cronJobId: ctx.id,
    sessionId: `memory-export:${ctx.id}`,
    // Required by the existing inbox envelope; internal jobs never route to Discord.
    groupName: "",
    channelId: "",
    content: "",
    timestamp: new Date().toISOString(),
  });
}
