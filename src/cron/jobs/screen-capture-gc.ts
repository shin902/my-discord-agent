import { cleanupExpiredCaptures } from "../../features/screen-capture.js";
import type { CronContext } from "../runner.js";

export default async function handler(_ctx: CronContext): Promise<void> {
  await cleanupExpiredCaptures();
}
