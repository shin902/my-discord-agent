import { openScreenCaptureDb } from "../../integrations/screen-capture/store.js";
import type { CronContext } from "../runner.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;

export default async function handler(_ctx: CronContext): Promise<void> {
  const db = openScreenCaptureDb();
  try {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    const result = db
      .prepare(
        "DELETE FROM screen_captures WHERE completed_at IS NOT NULL AND completed_at < ?",
      )
      .run(cutoff);
    console.log(`[screen-capture-gc] deleted=${result.changes}`);
  } finally {
    db.close();
  }
}
