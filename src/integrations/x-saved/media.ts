import { z } from "zod";

/** Keep aligned with x-saved-extension/src/media.ts. */
export function isImageSourceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      url.hostname === "pbs.twimg.com" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /^\/media\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

const position = z.number().int().min(0).max(15);
export const XSavedMediaSchema = z
  .array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("image"),
        position,
        source_url: z.string().refine(isImageSourceUrl),
        alt_text: z.string().max(10_000).optional(),
      }),
      z.strictObject({ kind: z.literal("video"), position }),
    ]),
  )
  .max(32)
  .refine(
    (media) =>
      new Set(media.map((entry) => `${entry.kind}:${entry.position}`)).size ===
      media.length,
    "Media keys must be unique",
  );

export type XSavedMedia = z.infer<typeof XSavedMediaSchema>[number];
