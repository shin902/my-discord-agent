// Minimal test handler with no external dependencies
// Used by runner.validation.test.ts only
import type { CronContext } from "../runner.js";

export default async function (_ctx: CronContext): Promise<void> {
  // no-op
}
