import type { Server } from "node:http";
import { loadScreenCaptureReceiverConfig } from "../config/screen-capture.js";
import { startScreenCaptureReceiver } from "../integrations/screen-capture/receiver.js";
import { openScreenCaptureDb } from "../integrations/screen-capture/store.js";

/** Screen capture owns its receiver admission; summary and GC remain cron handlers. */
export async function startScreenCapture(): Promise<Server | undefined> {
  const config = await loadScreenCaptureReceiverConfig();
  if (!config.enabled) return undefined;
  return startScreenCaptureReceiver({ port: config.port });
}

const RETENTION_MS = 24 * 60 * 60 * 1000;

export async function cleanupExpiredCaptures(): Promise<void> {
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
