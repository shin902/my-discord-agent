import { z } from "zod";
import { fetchFeed } from "../../rss/feed.js";
import {
  getFeedState,
  openRssDb,
  saveFeedEntries,
  touchFeed,
} from "../../rss/store.js";
import type { CronContext } from "../runner.js";

const FeedSchema = z.union([
  z
    .string()
    .url()
    .transform((url) => ({ url, name: undefined })),
  z.object({
    url: z.string().url(),
    name: z.string().min(1).optional(),
  }),
]);

const SettingsSchema = z.object({
  feeds: z.array(FeedSchema).min(1),
  bootstrap: z.enum(["mark-seen", "process"]).default("mark-seen"),
  statePath: z.string().min(1).optional(),
});

export default async function handler(ctx: CronContext): Promise<void> {
  const settings = SettingsSchema.parse(ctx.settings ?? {});
  const db = openRssDb(settings.statePath);
  try {
    for (const configuredFeed of settings.feeds) {
      try {
        const previous = getFeedState(db, configuredFeed.url);
        const result = await fetchFeed(
          configuredFeed.url,
          previous
            ? {
                etag: previous.etag,
                lastModified: previous.lastModified,
              }
            : undefined,
        );
        if (result.notModified) {
          if (previous) touchFeed(db, previous.id);
          continue;
        }

        const inserted = saveFeedEntries(db, {
          url: configuredFeed.url,
          configuredName: configuredFeed.name,
          parsedName: result.feed.title,
          etag: result.etag,
          lastModified: result.lastModified,
          entries: result.feed.entries,
          markInitialAsRead: settings.bootstrap === "mark-seen",
        });
        console.log(
          `[rss-collect] ${configuredFeed.name ?? result.feed.title ?? configuredFeed.url}: ${inserted}件を新規保存`,
        );
      } catch (err) {
        console.error(
          `[rss-collect] フィードの収集に失敗: ${configuredFeed.url}`,
          err,
        );
      }
    }
  } finally {
    db.close();
  }
}
