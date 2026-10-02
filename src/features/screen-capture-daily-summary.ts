import { z } from "zod";
import type { ScreenCaptureDailySummaryConfig } from "../config/screen-capture.js";
import { enqueueCronInbox } from "../cron/enqueue.js";
import { openScreenCaptureDb } from "../integrations/screen-capture/store.js";
import type { QueueRepository } from "../queue/repository.js";
import type { SourceHandlers } from "../queue/source-handlers.js";

const KIND = "screen-capture-daily-summary";
const dailyInput = z.strictObject({ date: z.iso.date() });

function advance(groupName: string, date: string): void {
  const db = openScreenCaptureDb();
  try {
    db.prepare(`INSERT INTO screen_capture_daily_progress(group_name, watermark)
      VALUES (?, ?) ON CONFLICT(group_name) DO UPDATE SET watermark = excluded.watermark
      WHERE excluded.watermark > watermark`).run(groupName, date);
  } finally {
    db.close();
  }
}

export function registerScreenCaptureDailySource(
  handlers: SourceHandlers,
  repository: QueueRepository,
  resume: (groupName: string) => void,
): void {
  handlers.register(KIND, dailyInput, {
    activeOnlyIdempotency: true,
    terminal(input, message) {
      if (repository.get(message.id)?.status !== "completed") return;
      advance(message.groupName, input.date);
      resume(message.groupName);
    },
  });
}

/** Observed days survive image GC; only the latest successful day is progress. */
export async function enqueueScreenCaptureDailySummary(
  config: ScreenCaptureDailySummaryConfig,
  repository: QueueRepository,
): Promise<void> {
  const db = openScreenCaptureDb();
  try {
    // A later captured day closes earlier days, even if its processing is pending.
    // No wall clock trigger: offline uploads retain their original JST date.
    const days = db
      .prepare(`SELECT date FROM screen_capture_days
      WHERE date >= ? AND date > COALESCE(
        (SELECT watermark FROM screen_capture_daily_progress WHERE group_name = ?), '')
      AND date < (SELECT MAX(date) FROM screen_capture_days)
      ORDER BY date`)
      .all(config.startDate, config.groupName) as { date: string }[];
    for (const { date } of days) {
      const key = `${KIND}:${config.groupName}:${date}`;
      const existing = repository.findByIdempotencyKey(key);
      if (existing?.status === "completed") {
        // Recover a successful queue commit whose feature callback was interrupted.
        advance(config.groupName, date);
        continue;
      }
      if (existing && existing.status !== "dead_letter") return;
      const pending = db.prepare(`SELECT 1 FROM screen_captures
        WHERE completed_at IS NULL AND received_at < ? LIMIT 1`);
      const cutoff = `${date}T15:00:00Z`;
      if (pending.get(cutoff)) return;
      await enqueueCronInbox(
        {
          ...config,
          id: KIND,
          idempotencyKey: key,
          feature: { kind: KIND, input: { date } },
          appendInbox: (input) => {
            // Validation above may await I/O while another upload is committed.
            if (!pending.get(cutoff)) repository.enqueue(input);
          },
        },
        `対象日: ${date} (Asia/Tokyo)。「昨日」ではなくこの日付だけを対象にしてください。\n\n${config.prompt.replaceAll("{{date}}", date)}`,
      );
      return; // One day at a time; success resumes catch-up, failure blocks it.
    }
  } finally {
    db.close();
  }
}
