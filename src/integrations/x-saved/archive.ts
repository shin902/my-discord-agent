import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { type ArchiveMedia, isMediaUrl } from "./media-contract.js";

const Id = z.string().regex(/^[1-9][0-9]{0,19}$/);
const FxEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("photo"),
    url: z.string(),
    altText: z.string().max(10_000).optional(),
  }),
  z.object({
    type: z.enum(["video", "gif"]),
    url: z.string().optional(),
    formats: z
      .array(
        z.object({
          url: z.string(),
          container: z.string().optional(),
          bitrate: z.number().finite().nonnegative().optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
]);
const FxResponse = z.object({
  code: z.literal(200),
  status: z.object({
    id: Id,
    type: z.literal("status"),
    provider: z.literal("twitter"),
    media: z
      .object({
        all: z.array(FxEntry).max(16).optional(),
        photos: z.array(z.unknown()).max(16).optional(),
        videos: z.array(z.unknown()).max(16).optional(),
      })
      .optional(),
  }),
});

/** v2's ordered focal media, not quotes/cards or separate photo/video ordering. */
export function parseArchiveMedia(
  raw: unknown,
  tweetId: string,
): ArchiveMedia[] {
  const { status } = FxResponse.parse(raw);
  if (status.id !== Id.parse(tweetId))
    throw new Error("FxTwitter Tweet ID mismatch");
  const all = status.media?.all ?? [];
  if (
    (status.media?.photos?.length ?? 0) + (status.media?.videos?.length ?? 0) >
    all.length
  ) {
    throw new Error("FxTwitter ordered media is incomplete");
  }
  return all.map((entry, position) => {
    if (entry.type === "photo") {
      if (!isMediaUrl(entry.url, "image"))
        throw new Error("Unsafe FxTwitter image URL");
      return {
        kind: "image",
        position,
        source_url: entry.url,
        alt_text: entry.altText,
      };
    }
    const mp4 = entry.formats
      ?.filter(
        (v) =>
          v.container === "mp4" || (!v.container && isMediaUrl(v.url, "video")),
      )
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
    // Some GIFs expose only url. Never fall back to HLS or an external host.
    const source =
      mp4?.url ??
      (entry.url?.split("?")[0]?.endsWith(".mp4") ? entry.url : undefined);
    if (source && !isMediaUrl(source, "video"))
      throw new Error("Unsafe FxTwitter MP4 URL");
    return { kind: "video", position, source_url: source };
  });
}

export async function lookupArchiveMedia(
  tweetId: string,
): Promise<ArchiveMedia[]> {
  Id.parse(tweetId);
  // Agent Reach also uses a fixed FxTwitter endpoint, no credentials/redirects,
  // 20s and 2 MiB. v2 permits an ID-only locator and exposes ordered formats.
  const response = await fetch(
    `https://api.fxtwitter.com/2/status/${tweetId}`,
    {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    },
  );
  try {
    if (!response.ok) throw new Error(`FxTwitter HTTP ${response.status}`);
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      ) ||
      !response.body
    ) {
      throw new Error("FxTwitter response is not JSON");
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024)
        throw new Error("FxTwitter response exceeds 2 MiB");
      chunks.push(chunk);
    }
    return parseArchiveMedia(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
      tweetId,
    );
  } finally {
    if (response.body && !response.body.locked)
      await response.body.cancel().catch(() => {});
  }
}

const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 512 * 1024 * 1024;

async function archiveDirectory(
  root: string,
  tweetId: string,
): Promise<string> {
  let directory = await realpath(root);
  for (const part of ["media", tweetId]) {
    directory = path.join(directory, part);
    await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(directory)).isDirectory())
      throw new Error("Unsafe media directory");
  }
  return directory;
}

/** X archive only: one image or one MP4, streamed to a sibling temp then renamed. */
export async function saveArchiveFile(
  root: string,
  tweetId: string,
  media: ArchiveMedia,
): Promise<string> {
  Id.parse(tweetId);
  z.number().int().min(0).max(15).parse(media.position);
  if (!media.source_url || !isMediaUrl(media.source_url, media.kind))
    throw new Error("Unsafe or missing media URL");
  const urls = [media.source_url];
  if (media.kind === "image") {
    const orig = new URL(media.source_url);
    orig.searchParams.set("name", "orig");
    if (orig.href !== media.source_url && isMediaUrl(orig.href, "image"))
      urls.unshift(orig.href);
  }
  const directory = await archiveDirectory(root, tweetId);
  for (const [index, source] of urls.entries()) {
    if (!isMediaUrl(source, media.kind)) throw new Error("Unsafe media URL");
    const signal = AbortSignal.timeout(
      media.kind === "video" ? 300_000 : 30_000,
    );
    const temp = path.join(
      directory,
      `.${media.position}-${randomUUID()}.part`,
    );
    let response: Response | undefined;
    try {
      response = await fetch(source, {
        credentials: "omit",
        redirect: "error",
        signal,
      });
      if (response.status !== 200 || !response.body)
        throw new Error(`Media HTTP ${response.status}`);
      const mime = response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase();
      const ext =
        media.kind === "video"
          ? mime === "video/mp4"
            ? "mp4"
            : undefined
          : IMAGE_EXTENSIONS.get(mime ?? "");
      if (!ext) throw new Error("Unsupported media content type");
      const maximum =
        media.kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES;
      if (Number(response.headers.get("content-length")) > maximum)
        throw new Error("Media exceeds byte limit");
      let bytes = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, next) {
          bytes += chunk.length;
          next(
            bytes > maximum ? new Error("Media exceeds byte limit") : null,
            chunk,
          );
        },
      });
      await archiveDirectory(root, tweetId);
      await pipeline(
        Readable.fromWeb(response.body),
        counter,
        createWriteStream(temp, { flags: "wx", mode: 0o600 }),
        { signal },
      );
      if (!bytes) throw new Error("Empty media file");
      await archiveDirectory(root, tweetId);
      const relative = `media/${tweetId}/${media.position}.${ext}`;
      await rename(temp, path.join(directory, `${media.position}.${ext}`));
      return relative;
    } catch (error) {
      if (index === urls.length - 1) throw error;
    } finally {
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => {});
      await rm(temp, { force: true });
    }
  }
  throw new Error("No media source");
}
