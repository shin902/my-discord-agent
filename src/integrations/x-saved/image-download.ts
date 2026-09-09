import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isImageSourceUrl } from "./media.js";

// Match the existing read tool's image budget; do not save unusable originals.
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

async function fetchImage(
  source: string,
): Promise<{ body: Buffer; extension: string }> {
  if (!isImageSourceUrl(source)) throw new Error("Invalid x-saved image URL");
  const response = await fetch(source, {
    method: "GET",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(15_000),
  });
  try {
    if (!response.ok) throw new Error(`Image returned HTTP ${response.status}`);
    const mime =
      response.headers
        .get("content-type")
        ?.split(";")[0]
        .trim()
        .toLowerCase() ?? "";
    const extension = IMAGE_EXTENSIONS.get(mime);
    if (!extension) throw new Error("Unsupported image content type");
    if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES)
      throw new Error("Image exceeds 10 MiB");
    if (!response.body) throw new Error("Empty image response");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) throw new Error("Image exceeds 10 MiB");
      chunks.push(chunk);
    }
    if (size === 0) throw new Error("Empty image response");
    return { body: Buffer.concat(chunks), extension };
  } finally {
    if (response.body && !response.body.locked)
      await response.body.cancel().catch(() => {});
  }
}

/** Host-only, unauthenticated pbs image GET; no video resolution or timers. */
export async function downloadXSavedImage(
  root: string,
  image: { tweet_id: string; position: number; source_url: string | null },
): Promise<string> {
  if (
    !/^[1-9][0-9]{0,19}$/.test(image.tweet_id) ||
    !Number.isInteger(image.position) ||
    image.position < 0 ||
    image.position > 15
  ) {
    throw new Error("Invalid x-saved image path identifiers");
  }
  if (!image.source_url || !isImageSourceUrl(image.source_url))
    throw new Error("Invalid x-saved image URL");
  const original = new URL(image.source_url);
  original.searchParams.set("name", "orig");
  let downloaded: Awaited<ReturnType<typeof fetchImage>>;
  try {
    downloaded = await fetchImage(original.toString());
  } catch (error) {
    if (original.toString() === new URL(image.source_url).toString())
      throw error;
    downloaded = await fetchImage(image.source_url);
  }

  // The mount can be writable by an agent: do not follow planted directory
  // symlinks outside the live root. Filenames never come from remote strings.
  const canonicalRoot = await realpath(root);
  let directory = canonicalRoot;
  for (const part of ["media", image.tweet_id]) {
    directory = path.join(directory, part);
    await mkdir(directory, { recursive: true });
    if ((await realpath(directory)) !== directory)
      throw new Error("Symlinked media directory is not allowed");
  }
  const relative = `media/${image.tweet_id}/${image.position}.${downloaded.extension}`;
  const temporary = path.join(
    directory,
    `.${image.position}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, downloaded.body, { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(canonicalRoot, relative));
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return relative;
}
