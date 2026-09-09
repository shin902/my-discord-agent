import { z } from "zod";
import { type XSavedMedia, XSavedMediaSchema } from "./media.js";

// FxTwitter API v2: only the focal status, never quotes/thread/card thumbnails.
// https://github.com/FxEmbed/FxEmbed/blob/main/docs/specs/fxtwitter-openapi.json
const MediaEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("photo"),
    url: z.string(),
    altText: z.string().optional(),
  }),
  z.object({ type: z.enum(["video", "gif"]) }),
]);
const ResponseSchema = z.object({
  code: z.literal(200),
  status: z.object({
    type: z.literal("status"),
    provider: z.literal("twitter"),
    id: z.string(),
    media: z.object({
      all: z.array(MediaEntrySchema).max(16).optional(),
      photos: z.array(z.unknown()).max(16).optional(),
      videos: z.array(z.unknown()).max(16).optional(),
    }),
  }),
});
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Host-only public metadata lookup. The sole input/locator is a Tweet ID. */
export async function resolveFxTwitterMedia(
  tweetId: string,
): Promise<XSavedMedia[]> {
  if (!/^[1-9][0-9]{0,19}$/.test(tweetId)) throw new Error("Invalid Tweet ID");
  const response = await fetch(
    `https://api.fxtwitter.com/2/status/${tweetId}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15_000),
    },
  );
  try {
    if (!response.ok)
      throw new Error(`FxTwitter returned HTTP ${response.status}`);
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() !== "application/json"
    )
      throw new Error("Invalid FxTwitter content type");
    if (
      Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES ||
      !response.body
    )
      throw new Error("Invalid FxTwitter response size");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES)
        throw new Error("FxTwitter response exceeds 1 MiB");
      chunks.push(chunk);
    }
    const parsed = ResponseSchema.safeParse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
    if (!parsed.success || parsed.data.status.id !== tweetId)
      throw new Error("Invalid FxTwitter status response");
    const media = parsed.data.status.media;
    // Separate photo/video lists cannot establish mixed-media positions.
    // Do not misclassify an incomplete response as a successful empty result.
    if (
      (media.photos?.length ?? 0) + (media.videos?.length ?? 0) >
      (media.all?.length ?? 0)
    )
      throw new Error("FxTwitter response lacks ordered media");
    const normalized = XSavedMediaSchema.safeParse(
      (media.all ?? []).map((entry, position) =>
        entry.type === "photo"
          ? {
              kind: "image",
              position,
              source_url: entry.url,
              ...(entry.altText ? { alt_text: entry.altText } : {}),
            }
          : { kind: "video", position },
      ),
    );
    if (!normalized.success)
      throw new Error("Invalid FxTwitter media metadata");
    return normalized.data;
  } finally {
    if (response.body && !response.body.locked)
      await response.body.cancel().catch(() => {});
  }
}
