import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetchFeedInBatches } from "../../rss/feed.js";
import {
  discardStagedFeedEntries,
  getFeedState,
  openRssDb,
  saveStagedFeedEntries,
  stageFeedEntries,
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

const MAX_CONCURRENT_FEEDS = 4;

export default async function handler(ctx: CronContext): Promise<void> {
  const settings = SettingsSchema.parse(ctx.settings ?? {});
  const db = openRssDb(settings.statePath);
  try {
    for (
      let start = 0;
      start < settings.feeds.length;
      start += MAX_CONCURRENT_FEEDS
    ) {
      await Promise.all(
        settings.feeds
          .slice(start, start + MAX_CONCURRENT_FEEDS)
          .map(async (configuredFeed) => {
            const collectionId = randomUUID();
            try {
              const previous = getFeedState(db, configuredFeed.url);
              const result = await fetchFeedInBatches(
                configuredFeed.url,
                (entries) => stageFeedEntries(db, collectionId, entries),
                previous
                  ? {
                      etag: previous.etag,
                      lastModified: previous.lastModified,
                    }
                  : undefined,
              );
              if (result.notModified) {
                discardStagedFeedEntries(db, collectionId);
                if (previous) touchFeed(db, previous.id, configuredFeed.name);
                return;
              }

              const inserted = saveStagedFeedEntries(db, {
                collectionId,
                url: configuredFeed.url,
                configuredName: configuredFeed.name,
                parsedName: result.feed.title,
                etag: result.etag,
                lastModified: result.lastModified,
                markInitialAsRead: settings.bootstrap === "mark-seen",
              });
              console.log(
                `[rss-collect] ${configuredFeed.name ?? result.feed.title ?? configuredFeed.url}: ${inserted}件を新規保存`,
              );
            } catch (err) {
              discardStagedFeedEntries(db, collectionId);
              console.error(
                `[rss-collect] フィードの収集に失敗: ${configuredFeed.url}`,
                err,
              );
            }
          }),
      );
    }
  } finally {
    db.close();
  }
}
