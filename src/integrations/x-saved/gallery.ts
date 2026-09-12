import { open } from "node:fs/promises";
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
async function readForm(request: IncomingMessage) {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers["content-type"] ?? "",
    )
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
  return Object.fromEntries(
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
  // Only the format comes from SQLite; the route determines the archive path.
  const ext = path.extname(row?.local_path ?? "").slice(1);
  if (
    !row ||
    !Object.hasOwn(MEDIA_TYPES, ext) ||
    (kind === "video") !== (ext === "mp4")
  ) {
    throw new HttpError(404, "保存ファイルがありません。");
  }
  const handle = await open(
    path.join(root, "media", tweetId, `${position}.${ext}`),
    "r",
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !stat.size)
      throw new HttpError(404, "保存ファイルがありません。");
    let start = 0;
    let end = stat.size - 1;
    // Native video needs single byte ranges; unsupported ranges receive the full file.
    const range =
      !request.headers["if-range"] &&
      /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    const partial = range && (range[1] || range[2]);
    if (partial) {
      start = range[1]
        ? Number(range[1])
        : Math.max(0, stat.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end) {
        response.setHeader("Content-Range", `bytes */${stat.size}`);
        throw new HttpError(416, "Invalid byte range");
      }
      response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
    response.writeHead(partial ? 206 : 200, {
      "Content-Type": MEDIA_TYPES[ext],
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
    });
    await pipeline(
      handle.createReadStream({ start, end, autoClose: false }),
      response,
    );
  } finally {
    await handle.close();
  }
}

/** Single-user localhost service behind Tailscale Serve. Host SQLite, archive
 * and local processes are trusted; external Tweet content is not. */
export async function startXSavedGallery(options: {
  port: number;
  origin: string;
  xSavedDbPath?: string;
}) {
  XSavedGalleryConfigSchema.parse({
    enabled: true,
    origin: options.origin,
  });
  const dbPath = resolveXSavedDbPath(options.xSavedDbPath);
  const db = openXSavedDb(dbPath);
  const root = path.dirname(dbPath);
  // Long Unicode label filters can exceed Node's default 16 KiB.
  const server = createServer({ maxHeaderSize: 256 * 1024 });
  server.on("request", async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    // Do not duplicate a long filter URL in subsequent request headers.
    response.setHeader("Referrer-Policy", "origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        throw new HttpError(405, "Method not allowed");
      }
      if (
        request.method === "POST" &&
        request.headers.origin !== options.origin
      ) {
        throw new HttpError(403, "Galleryの画面から保存してください。");
      }
      const url = new URL(request.url ?? "/", options.origin);
      const detail = /^\/items\/([1-9][0-9]{0,19})$/.exec(url.pathname);
      const query = url.searchParams.toString();
      if (request.method === "POST") {
        if (!detail) throw new HttpError(404, "Not found");
        const fields = await readForm(request);
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
              query,
              invalid
                ? "保存していません。Status、各50個・1値100文字までの分類を確認してください。"
                : "保存できませんでした。入力は残っています。時間をおいて再試行してください。",
              fields,
            ),
          );
          return;
        }
        // A fragment redirect keeps the current query without a huge Location header.
        response.writeHead(303, { Location: "#saved" });
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
        const filters = GalleryFilterSchema.parse(
          Object.fromEntries(url.searchParams),
        );
        send(response, 200, galleryListPage(filters, listGallery(db, filters)));
        return;
      }
      if (detail) {
        const item = getGalleryItem(db, detail[1]);
        if (!item) throw new HttpError(404, "Tweetがありません。");
        send(response, 200, galleryDetailPage(item, query));
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
            : ["ENOENT", "ENOTDIR"].includes(
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
