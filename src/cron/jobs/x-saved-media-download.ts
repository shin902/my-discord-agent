import path from "node:path";
import { z } from "zod";
import {
  lookupArchiveMedia,
  saveArchiveFile,
} from "../../integrations/x-saved/archive.js";
import type { ArchiveMedia } from "../../integrations/x-saved/media-contract.js";
import {
  mergeXSavedMedia,
  openXSavedDb,
  resolveXSavedDbPath,
} from "../../integrations/x-saved/store.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const Settings = z.strictObject({
  limit: z.number().int().min(1).max(100).default(20),
});

export default async function handler(ctx: CronContext): Promise<void> {
  const settings = Settings.safeParse(ctx.settings ?? {});
  if (!settings.success)
    throw new NonRetryableError("Invalid x-saved-media-download settings");
  const { limit } = settings.data;
  const dbPath = resolveXSavedDbPath();
  const db = openXSavedDb(dbPath);
  let resolved = 0;
  let downloaded = 0;
  try {
    // Null (never attempted) first, then oldest attempts: a 404 cannot block backlog.
    const tweets = db
      .prepare(`SELECT tweet_id FROM x_items WHERE media_resolved_at IS NULL
      ORDER BY media_resolve_attempted_at, tweet_id LIMIT ?`)
      .all(limit) as { tweet_id: string }[];
    for (const { tweet_id } of tweets) {
      const now = new Date().toISOString();
      db.prepare(
        "UPDATE x_items SET media_resolve_attempted_at = ? WHERE tweet_id = ?",
      ).run(now, tweet_id);
      let media: ArchiveMedia[];
      try {
        media = await lookupArchiveMedia(tweet_id);
      } catch (error) {
        console.warn(
          `[x-saved-media-download] resolve ${tweet_id}: ${String(error).slice(0, 300)}`,
        );
        continue;
      }
      // DB errors are deliberately outside the per-Tweet network failure catch.
      mergeXSavedMedia(db, tweet_id, media, now);
      resolved++;
    }
    const files = db
      .prepare(`SELECT tweet_id, kind, position, source_url FROM x_media
      WHERE status IN ('pending', 'failed') AND (source_url IS NOT NULL OR status = 'pending')
      ORDER BY status = 'failed', tweet_id, position, kind LIMIT ?`)
      .all(limit) as (Omit<ArchiveMedia, "source_url"> & {
      tweet_id: string;
      source_url: string | null;
    })[];
    for (const file of files) {
      let localPath: string | null = null;
      let error: string | null = null;
      try {
        if (!file.source_url)
          throw new Error(
            "Direct media URL unavailable (MP4 required for video)",
          );
        localPath = await saveArchiveFile(path.dirname(dbPath), file.tweet_id, {
          ...file,
          source_url: file.source_url,
        });
      } catch (cause) {
        error = String(cause).slice(0, 1000);
      }
      db.prepare(`UPDATE x_media SET status = ?, local_path = ?, last_error = ?
        WHERE tweet_id = ? AND kind = ? AND position = ? AND status != 'done' AND source_url IS ?`).run(
        error ? "failed" : "done",
        localPath,
        error,
        file.tweet_id,
        file.kind,
        file.position,
        file.source_url,
      );
      if (!error) downloaded++;
    }
    console.log(
      `[x-saved-media-download] resolved=${resolved}/${tweets.length} downloaded=${downloaded}/${files.length}`,
    );
  } finally {
    db.close();
  }
}
