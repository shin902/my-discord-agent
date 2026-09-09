import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { MediaHintsSchema } from "./media-contract.js";
import { ingestXSavedItems, type XSavedItem } from "./store.js";

export const MAX_BATCH_SIZE = 50;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const BrowserItemSchema = z
  .strictObject({
    tweet_id: z.string().regex(/^[1-9][0-9]{0,19}$/),
    text: z.string().max(100_000),
    author: z
      .string()
      .regex(/^@?[A-Za-z0-9_]{1,15}$|^$/)
      .optional(),
    url: z.string().max(200),
    created_at: z
      .union([z.iso.datetime({ offset: true }), z.literal("")])
      .optional(),
    kind: z.enum(["like", "bookmark"]),
    media: MediaHintsSchema.optional(),
  })
  .refine((item) => {
    const match =
      /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/([0-9]+)$/.exec(
        item.url,
      );
    return (
      match?.[2] === item.tweet_id &&
      (!item.author ||
        item.author.replace(/^@/, "").toLowerCase() === match[1]?.toLowerCase())
    );
  }, "URL must match tweet_id and any supplied author");

const BatchSchema = z.strictObject({
  items: z.array(BrowserItemSchema).min(1).max(MAX_BATCH_SIZE),
  idempotency_key: z.string().min(1).max(200).optional(),
});

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

/** Host-only ingestion, deliberately independent of the agent Tool Proxy. */
export async function startXSavedReceiver(options: {
  port: number;
  xSavedDbPath?: string;
}) {
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/x-saved/items") {
      reply(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      reply(response, 405, { error: "Method not allowed" });
      return;
    }
    // Extension service-worker requests use optional host permissions, not
    // web-page CORS. Do not allow arbitrary web pages to write to localhost.
    const origin = request.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      reply(response, 403, { error: "Origin not allowed" });
      return;
    }
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        request.headers["content-type"] ?? "",
      ) ||
      request.headers["content-encoding"] !== undefined
    ) {
      reply(response, 415, { error: "Expected uncompressed application/json" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) {
          response.setHeader("Connection", "close");
          reply(response, 413, { error: "Request body too large" });
          return;
        }
        chunks.push(bytes);
      }
    } catch {
      if (!response.destroyed)
        reply(response, 400, { error: "Incomplete request" });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
    } catch {
      reply(response, 400, { error: "Invalid JSON" });
      return;
    }
    const parsed = BatchSchema.safeParse(payload);
    if (!parsed.success) {
      reply(response, 400, { error: "Invalid saved-item batch" });
      return;
    }
    const items: XSavedItem[] = parsed.data.items.map((item) => ({
      tweetId: item.tweet_id,
      text: item.text,
      ...(item.author ? { authorHandle: item.author.replace(/^@/, "") } : {}),
      ...(item.created_at ? { tweetCreatedAt: item.created_at } : {}),
      seenLiked: item.kind === "like",
      seenBookmarked: item.kind === "bookmark",
      media: item.media,
      // Browser captures carry no external URL metadata: omit it to preserve
      // any metadata already held in SQLite.
    }));
    try {
      ingestXSavedItems(items, { xSavedDbPath: options.xSavedDbPath });
    } catch {
      reply(response, 500, { error: "Unable to commit saved items" });
      return;
    }
    reply(response, 200, {
      accepted: [
        ...new Set(
          parsed.data.items.map((item) => `${item.kind}:${item.tweet_id}`),
        ),
      ],
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}
