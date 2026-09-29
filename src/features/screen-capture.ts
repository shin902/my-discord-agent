import type { Server } from "node:http";
import {
  loadScreenCaptureReceiverConfig,
  loadScreenCaptureSummaryConfig,
  type ScreenCaptureSummaryConfig,
} from "../config/screen-capture.js";
import { startScreenCaptureReceiver } from "../integrations/screen-capture/receiver.js";
import { openScreenCaptureDb } from "../integrations/screen-capture/store.js";
import { summarizeScreenCaptureBatch } from "./screen-capture-summary.js";

/** Start the receiver and recover any full pending batches after host setup. */
export async function startScreenCapture(): Promise<Server | undefined> {
  const config = await loadScreenCaptureReceiverConfig();
  const summary = await loadScreenCaptureSummaryConfig();
  const consume = summary ? createSummaryConsumer(summary) : undefined;
  const receiver = config.enabled
    ? await startScreenCaptureReceiver({ port: config.port, onStored: consume })
    : undefined;
  consume?.();
  return receiver;
}

function createSummaryConsumer(config: ScreenCaptureSummaryConfig): () => void {
  let running = false;
  let signaled = false;
  return () => {
    signaled = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        do {
          signaled = false;
          try {
            while (await summarizeScreenCaptureBatch(config)) {
              // Each invocation owns exactly one oldest-first batch.
            }
          } catch (error) {
            // Leave failed batches pending for a future upload or host restart.
            console.error("[screen-capture-summary] processing failed:", error);
          }
        } while (signaled);
      } finally {
        running = false;
      }
    })();
  };
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
