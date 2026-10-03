import type { Server } from "node:http";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import {
  loadScreenCaptureDailySummaryConfig,
  loadScreenCaptureReceiverConfig,
  loadScreenCaptureSummaryConfig,
  type ScreenCaptureDailySummaryConfig,
  type ScreenCaptureSummaryConfig,
} from "../config/screen-capture.js";
import { startScreenCaptureReceiver } from "../integrations/screen-capture/receiver.js";
import { openScreenCaptureDb } from "../integrations/screen-capture/store.js";
import { getQueueRepository } from "../queue/repository.js";
import type { SourceHandlers } from "../queue/source-handlers.js";
import {
  enqueueScreenCaptureDailySummary,
  registerScreenCaptureDailySource,
} from "./screen-capture-daily-summary.js";
import {
  registerScreenCaptureSource,
  summarizeScreenCaptureBatch,
} from "./screen-capture-summary.js";

/** Start the receiver and recover any full pending batches after host setup. */
export async function startScreenCapture(
  sources: SourceHandlers,
): Promise<Server | undefined> {
  const config = await loadScreenCaptureReceiverConfig();
  const summary = await loadScreenCaptureSummaryConfig();
  const daily = await loadScreenCaptureDailySummaryConfig();
  if (daily && (!summary || daily.groupName !== summary.groupName))
    throw new Error(
      "screenCaptureDailySummary requires enabled screenCaptureSummary with the same groupName",
    );
  // enqueueCronInbox only resolves botId when a day closes, so an unknown or
  // cross-group Bot would be logged and swallowed. Resolve it at startup like
  // loadAndValidateCron() does for cron jobs.
  if (daily?.botId) {
    resolveBotProfile(await loadBotRegistry(), daily.botId, daily.groupName);
  }
  const consume = summary ? createSummaryConsumer(summary, daily) : undefined;
  registerScreenCaptureSource(sources, getQueueRepository(), (groupName) => {
    if (groupName === summary?.groupName) consume?.();
  });
  registerScreenCaptureDailySource(
    sources,
    getQueueRepository(),
    (groupName) => {
      if (groupName === summary?.groupName) consume?.();
    },
  );
  const receiver = config.enabled
    ? await startScreenCaptureReceiver({ port: config.port, onStored: consume })
    : undefined;
  consume?.();
  return receiver;
}

function createSummaryConsumer(
  config: ScreenCaptureSummaryConfig,
  daily: ScreenCaptureDailySummaryConfig | undefined,
): () => void {
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
          if (daily) {
            try {
              await enqueueScreenCaptureDailySummary(
                daily,
                getQueueRepository(),
              );
            } catch (error) {
              console.error(
                "[screen-capture-daily-summary] processing failed:",
                error,
              );
            }
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
