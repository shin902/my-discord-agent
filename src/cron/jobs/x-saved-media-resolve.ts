import { z } from "zod";
import { resolveFxTwitterMedia } from "../../integrations/x-saved/fxtwitter.js";
import type { XSavedMedia } from "../../integrations/x-saved/media.js";
import {
  openXSavedDb,
  recordResolvedXSavedMedia,
} from "../../integrations/x-saved/store.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const SettingsSchema = z.strictObject({
  limit: z.number().int().positive().max(100).default(20),
});

export default async function handler(ctx: CronContext): Promise<void> {
  const parsed = SettingsSchema.safeParse(ctx.settings ?? {});
  if (!parsed.success)
    throw new NonRetryableError(
      `[x-saved-media-resolve] settings error: ${parsed.error.message}`,
    );
  const db = openXSavedDb();
  try {
    // Existing DOM media is not a completeness signal. Include legacy text-only
    // rows and partial/complete DOM hints alike, independently of browser dedupe.
    const items = db
      .prepare(`
      SELECT i.tweet_id FROM x_items i
      LEFT JOIN x_media_resolution r USING (tweet_id)
      WHERE r.resolved_at IS NULL
      ORDER BY r.last_attempt_at, i.tweet_id
      LIMIT ?
    `)
      .all(parsed.data.limit) as Array<{ tweet_id: string }>;
    const attempt = db.prepare(`
      INSERT INTO x_media_resolution (tweet_id, last_attempt_at) VALUES (?, ?)
      ON CONFLICT(tweet_id) DO UPDATE SET last_attempt_at = excluded.last_attempt_at
    `);
    let resolved = 0;
    let failed = 0;
    for (const { tweet_id } of items) {
      // Rotate failures behind unattempted/older attempts: one unavailable ID
      // cannot starve the backlog. No retry counters, leases or own scheduler.
      attempt.run(tweet_id, new Date().toISOString());
      let media: XSavedMedia[];
      try {
        media = await resolveFxTwitterMedia(tweet_id);
      } catch (cause) {
        failed++;
        const error = (
          cause instanceof Error ? cause.message : "Resolution failed"
        )
          .replace(/\s+/g, " ")
          .slice(0, 200);
        console.warn(`[x-saved-media-resolve] ${tweet_id}: ${error}`);
        continue;
      }
      // Only a committed result (including []) marks the ID resolved.
      // Database failures fail the job rather than masquerading as API errors.
      recordResolvedXSavedMedia(db, tweet_id, media);
      resolved++;
    }
    console.log(
      `[x-saved-media-resolve] selected=${items.length} resolved=${resolved} failed=${failed}`,
    );
  } finally {
    db.close();
  }
}
