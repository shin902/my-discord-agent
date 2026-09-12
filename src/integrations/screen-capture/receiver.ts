import { createServer, type ServerResponse } from "node:http";
import { z } from "zod";
import { openScreenCaptureDb } from "./store.js";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

function reply(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

/** Reachable from the Tailnet through Tailscale Serve, never a public bind. */
export async function startScreenCaptureReceiver(options: {
  port: number;
  dbPath?: string;
}) {
  const db = openScreenCaptureDb(options.dbPath);
  const insert =
    db.prepare(`INSERT INTO screen_captures (id, image, received_at)
    VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`);
  const matches = db.prepare(
    "SELECT 1 FROM screen_captures WHERE id = ? AND image = ?",
  );
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/screen-captures") {
      reply(response, 404, { error: "Not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("Allow", "POST");
      reply(response, 405, { error: "Method not allowed" });
      return;
    }
    // curl has no Origin. No browser/CORS write access, including localhost pages.
    if (request.headers.origin !== undefined) {
      reply(response, 403, { error: "Origin not allowed" });
      return;
    }
    if (
      request.headers["content-type"]?.toLowerCase() !== "image/png" ||
      request.headers["content-encoding"] !== undefined
    ) {
      reply(response, 415, { error: "Expected uncompressed image/png" });
      return;
    }
    const parsedId = z.uuid().safeParse(request.headers["x-capture-id"]);
    if (!parsedId.success) {
      reply(response, 400, { error: "X-Capture-Id must be a UUID" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_IMAGE_BYTES) {
          response.setHeader("Connection", "close");
          reply(response, 413, { error: "Image too large" });
          return;
        }
        chunks.push(bytes);
      }
    } catch {
      if (!response.destroyed)
        reply(response, 400, { error: "Incomplete request" });
      return;
    }
    const image = Buffer.concat(chunks);
    if (
      size <= PNG_SIGNATURE.length ||
      !image.subarray(0, 8).equals(PNG_SIGNATURE)
    ) {
      reply(response, 400, { error: "Expected PNG bytes" });
      return;
    }
    const id = parsedId.data.toLowerCase();
    try {
      insert.run(id, image, new Date().toISOString());
      // A retry must not replace a different capture or reset its summary.
      if (!matches.get(id, image)) {
        reply(response, 409, {
          error: "Capture ID already has different bytes",
        });
        return;
      }
    } catch {
      reply(response, 500, { error: "Unable to commit capture" });
      return;
    }
    reply(response, 200, { accepted: id });
  });
  server.requestTimeout = 30_000;
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
