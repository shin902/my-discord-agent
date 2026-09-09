import { z } from "zod";

export type ArchiveMedia = {
  kind: "image" | "video";
  position: number;
  source_url?: string;
  alt_text?: string;
};

/** Fixed X CDN targets only. Called again immediately before every download. */
export function isMediaUrl(value: string, kind: ArchiveMedia["kind"]): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      (kind === "image"
        ? url.hostname === "pbs.twimg.com" &&
          /^\/media\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(url.pathname)
        : url.hostname === "video.twimg.com" &&
          /^\/(?:ext_tw_video|amplify_video|tweet_video)\/[A-Za-z0-9_/-]+\.mp4$/.test(
            url.pathname,
          ))
    );
  } catch {
    return false;
  }
}

// PR #2's wire contract: video presence only; MP4 sources are host-resolved.
const position = z.number().int().min(0).max(15);
export const MediaHintsSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("image"),
        position,
        source_url: z.string().refine((value) => isMediaUrl(value, "image")),
        alt_text: z.string().max(10_000).optional(),
      }),
      z.strictObject({ kind: z.literal("video"), position }),
    ]),
  )
  .max(32)
  .refine(
    (entries) =>
      new Set(entries.map((m) => `${m.kind}:${m.position}`)).size ===
      entries.length,
  );
