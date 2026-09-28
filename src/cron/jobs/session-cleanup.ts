import type { CronContext } from "../runner.js";
import { cleanupEphemeralCronSessions } from "../session-retention.js";

export default async function handler(_ctx: CronContext): Promise<void> {
  const removed = await cleanupEphemeralCronSessions();
  console.log(`[session-cleanup] removed ${removed} expired sessions`);
}
