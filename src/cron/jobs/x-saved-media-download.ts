import path from "node:path";
import { z } from "zod";
import { downloadXSavedImage } from "../../integrations/x-saved/image-download.js";
import {
  openXSavedDb,
  resolveXSavedDbPath,
} from "../../integrations/x-saved/store.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const SettingsSchema = z.strictObject({
  limit: z.number().int().positive().max(100).default(20),
});

export default async function handler(ctx: CronContext): Promise<void> {
  const parsed = SettingsSchema.safeParse(ctx.settings ?? {});
  if (!parsed.success) {
    throw new NonRetryableError(
      `[x-saved-media-download] settings error: ${parsed.error.message}`,
    );
  }
  const dbPath = resolveXSavedDbPath();
  const db = openXSavedDb(dbPath);
  try {
    const images = db
      .prepare(`
      SELECT tweet_id, position, source_url FROM x_media
      WHERE kind = 'image' AND status IN ('pending', 'failed')
      ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, tweet_id, position
      LIMIT ?
    `)
      .all(parsed.data.limit) as Array<{
      tweet_id: string;
      position: number;
      source_url: string | null;
    }>;
    const update = db.prepare(`
      UPDATE x_media SET status = @status, local_path = @localPath, last_error = @error
      WHERE tweet_id = @tweet_id AND kind = 'image' AND position = @position
        AND source_url IS @source_url AND status != 'done'
    `);
    let done = 0;
    let failed = 0;
    for (const image of images) {
      let localPath: string | null = null;
      let error: string | null = null;
      try {
        localPath = await downloadXSavedImage(path.dirname(dbPath), image);
      } catch (cause) {
        error = (
          cause instanceof Error ? cause.message : "Image download failed"
        )
          .replace(/\s+/g, " ")
          .slice(0, 200);
      }
      // DB failures are job failures, not download failures. A concurrent
      // enrichment must not receive a stale outcome for an older source URL.
      const result = update.run({
        ...image,
        status: error === null ? "done" : "failed",
        localPath,
        error,
      });
      if (result.changes) {
        if (error === null) done++;
        else {
          failed++;
          console.warn(
            `[x-saved-media-download] ${image.tweet_id}/${image.position}: ${error}`,
          );
        }
      }
    }
    console.log(
      `[x-saved-media-download] selected=${images.length} done=${done} failed=${failed}`,
    );
  } finally {
    db.close();
  }
}
