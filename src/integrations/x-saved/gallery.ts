import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type Database from "better-sqlite3";
import { z } from "zod";
import { XSavedGalleryConfigSchema } from "../../config/x-saved.js";
import {
  GalleryFilterSchema,
  getGalleryItem,
  listGallery,
  updateGalleryItem,
} from "./gallery-store.js";
import {
  GALLERY_CSS,
  galleryDetailPage,
  galleryListPage,
  galleryPage,
} from "./gallery-view.js";
import { openXSavedDb, resolveXSavedDbPath } from "./store.js";

const MAX_FORM_BYTES = 256 * 1024;
const MEDIA_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
};
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function send(
  response: ServerResponse,
  status: number,
  body: string,
  type = "text/html; charset=utf-8",
) {
  response.writeHead(status, { "Content-Type": type });
  response.end(body);
}
function parameters(params: URLSearchParams): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (key in result)
      throw new HttpError(400, "同じ項目を複数回指定できません。");
    result[key] = value;
  }
  return result;
}
function backLink(value?: string): string {
  return value && value.length <= 8_000 && /^\/\?[^#\r\n]*$/.test(value)
    ? value
    : "/";
}
async function readForm(request: IncomingMessage) {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers["content-type"] ?? "",
    ) ||
    request.headers["content-encoding"]
  ) {
    throw new HttpError(415, "通常のフォームで送信してください。");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_FORM_BYTES)
      throw new HttpError(
        413,
        "入力が大きすぎます。分類の値を減らしてください。",
      );
    chunks.push(bytes);
  }
  return parameters(
    new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
  );
}

/** Serve only the owning row's completed archive file, never a caller-supplied path. */
async function serveMedia(
  db: Database.Database,
  root: string,
  match: RegExpMatchArray,
  request: IncomingMessage,
  response: ServerResponse,
) {
  const [, tweetId, kind, position] = match;
  const row = db
    .prepare(`SELECT local_path FROM x_media
    WHERE tweet_id = ? AND kind = ? AND position = ? AND status = 'done'`)
    .get(tweetId, kind, Number(position)) as
    | { local_path: string | null }
    | undefined;
  const relative = row?.local_path;
  const ext = relative?.match(
    /^media\/[1-9][0-9]{0,19}\/(?:[0-9]|1[0-5])\.(jpg|png|webp|gif|mp4)$/,
  )?.[1];
  if (
    !ext ||
    relative !== `media/${tweetId}/${position}.${ext}` ||
    (kind === "video") !== (ext === "mp4")
  ) {
    throw new HttpError(404, "保存ファイルがありません。");
  }
  // Reject symlinks at every archive component (including the final file).
  let file = root;
  for (const segment of relative.split("/")) {
    file = path.join(file, segment);
    if ((await lstat(file)).isSymbolicLink())
      throw new HttpError(404, "保存ファイルがありません。");
  }
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size)
      throw new HttpError(404, "保存ファイルがありません。");
    // On the Linux host, verify the opened descriptor too: an untrusted mounted
    // directory must not swap an ancestor for a symlink between lstat and open.
    if (
      process.platform === "linux" &&
      (await realpath(`/proc/self/fd/${handle.fd}`)) !== file
    ) {
      throw new HttpError(404, "保存ファイルがありません。");
    }
    let start = 0;
    let end = stat.size - 1;
    const range =
      request.method === "GET" && !request.headers["if-range"]
        ? request.headers.range
        : undefined;
    if (range) {
      response.setHeader("Content-Range", `bytes */${stat.size}`);
      const parts = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (
        !parts ||
        (!parts[1] && !parts[2]) ||
        parts.slice(1).some((n) => n && !Number.isSafeInteger(Number(n)))
      )
        throw new HttpError(416, "Invalid byte range");
      start = parts[1]
        ? Number(parts[1])
        : Math.max(0, stat.size - Number(parts[2]));
      end = parts[1] && parts[2] ? Math.min(Number(parts[2]), end) : end;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= stat.size
      ) {
        throw new HttpError(416, "Invalid byte range");
      }
      response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    response.writeHead(range ? 206 : 200, {
      "Content-Type": MEDIA_TYPES[ext],
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    if (request.method === "HEAD") response.end();
    else
      await pipeline(
        handle.createReadStream({ start, end, autoClose: false }),
        response,
      );
  } finally {
    await handle.close();
  }
}

/** Separate human-facing listener. Tailscale Serve is its only trusted proxy. */
export async function startXSavedGallery(options: {
  port: number;
  origin: string;
  allowedLogin: string;
  xSavedDbPath?: string;
}) {
  XSavedGalleryConfigSchema.parse({
    enabled: true,
    origin: options.origin,
    allowedLogin: options.allowedLogin,
  });
  const host = new URL(options.origin).host;
  const dbPath = resolveXSavedDbPath(options.xSavedDbPath);
  const db = openXSavedDb(dbPath);
  const root = await realpath(path.dirname(dbPath));
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    // no-referrer turns native form POST Origin into null in Chromium.
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'self'; img-src 'self'; media-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      // Serve strips incoming identity headers, supplies the authenticated user,
      // and omits that identity for Funnel/tagged devices. Local processes are trusted.
      if (
        request.headers.host !== host ||
        request.headers["tailscale-user-login"] !== options.allowedLogin ||
        request.headers["tailscale-funnel-request"] !== undefined
      ) {
        throw new HttpError(
          403,
          "自分のTailscaleアカウントで接続した端末から開いてください。",
        );
      }
      if (
        request.method !== "GET" &&
        request.method !== "HEAD" &&
        request.method !== "POST"
      ) {
        response.setHeader("Allow", "GET, HEAD, POST");
        throw new HttpError(405, "Method not allowed");
      }
      if (
        request.method === "POST" &&
        (request.headers.origin !== options.origin ||
          request.headers["sec-fetch-site"] === "cross-site")
      ) {
        throw new HttpError(403, "Galleryの画面から保存してください。");
      }
      if (
        !request.url?.startsWith("/") ||
        request.url.startsWith("//") ||
        request.url.length > 8_000
      ) {
        throw new HttpError(400, "URLが不正か長すぎます。");
      }
      const url = new URL(request.url, options.origin);
      const detail = /^\/items\/([1-9][0-9]{0,19})$/.exec(url.pathname);
      if (request.method === "POST") {
        if (!detail) throw new HttpError(404, "Not found");
        const form = await readForm(request);
        const { back, ...fields } = form;
        const item = getGalleryItem(db, detail[1]);
        if (!item) throw new HttpError(404, "Tweetがありません。");
        try {
          updateGalleryItem(db, detail[1], fields);
        } catch (error) {
          const invalid = error instanceof z.ZodError;
          send(
            response,
            invalid ? 400 : 500,
            galleryDetailPage(
              item,
              backLink(back),
              invalid
                ? "保存していません。Status、各50個・1値100文字までの分類を確認してください。"
                : "保存できませんでした。入力は残っています。時間をおいて再試行してください。",
              fields,
            ),
          );
          return;
        }
        response.writeHead(303, {
          Location: `/items/${detail[1]}?saved=1&back=${encodeURIComponent(backLink(back))}`,
        });
        response.end();
        return;
      }
      if (url.pathname === "/gallery.css") {
        send(response, 200, GALLERY_CSS, "text/css; charset=utf-8");
        return;
      }
      const media =
        /^\/media\/([1-9][0-9]{0,19})\/(image|video)\/([0-9]|1[0-5])$/.exec(
          url.pathname,
        );
      if (media) {
        await serveMedia(db, root, media, request, response);
        return;
      }
      if (url.pathname === "/") {
        const filters = GalleryFilterSchema.parse(parameters(url.searchParams));
        send(response, 200, galleryListPage(filters, listGallery(db, filters)));
        return;
      }
      if (detail) {
        const item = getGalleryItem(db, detail[1]);
        if (!item) throw new HttpError(404, "Tweetがありません。");
        send(
          response,
          200,
          galleryDetailPage(
            item,
            backLink(url.searchParams.get("back") ?? undefined),
            url.searchParams.get("saved") === "1" ? "変更を保存しました。" : "",
          ),
        );
        return;
      }
      throw new HttpError(404, "Not found");
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError
            ? 400
            : ["ENOENT", "ENOTDIR", "ELOOP"].includes(
                  (error as NodeJS.ErrnoException).code ?? "",
                )
              ? 404
              : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : status === 400
            ? "条件が不正です。日付や入力値を確認してください。"
            : status === 404
              ? "保存ファイルがありません。"
              : "処理できませんでした。変更は保存されていません。時間をおいて再試行してください。";
      response.setHeader("Connection", "close");
      send(
        response,
        status,
        galleryPage(
          String(status),
          `<h2>${message}</h2><a href="/">一覧を開く</a>`,
        ),
      );
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.once("close", () => db.close());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    db.close();
    throw error;
  }
  return server;
}
