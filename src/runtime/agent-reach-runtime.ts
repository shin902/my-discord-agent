import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { refreshRedditCookies } from "../proxy/reddit-cookie-refresh.js";
import { agentReachTool } from "../tools/agent-reach.js";

const port = Number(process.env.PORT ?? 8787);
function runtimeToken(): string | undefined {
  return process.env.AGENT_REACH_RUNTIME_TOKEN;
}
function refreshToken(): string | undefined {
  return process.env.AGENT_REACH_REFRESH_TOKEN;
}
const calls = new Map<string, AbortController>();
const bodyLimit = 16 * 1024;

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function bearer(req: http.IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return typeof value === "string" && /^Bearer \S+$/.test(value)
    ? value.slice("Bearer ".length)
    : undefined;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > bodyLimit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function validCall(value: unknown): value is { callId: string; url: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).callId === "string" &&
    typeof (value as Record<string, unknown>).url === "string" &&
    Object.keys(value).length === 2
  );
}

export async function handleAgentReachRuntimeRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const path = req.url?.split("?", 1)[0] ?? "/";
  if (path === "/healthz" && req.method === "GET") {
    json(res, 200, { ok: true });
    return;
  }
  if (path.startsWith("/maintenance/") && req.method === "POST") {
    if (!refreshToken() || bearer(req) !== refreshToken()) {
      json(res, 401, { error: "Unauthorized" });
      return;
    }
    if (path !== "/maintenance/reddit-cookie-refresh") {
      json(res, 404, { error: "Not Found" });
      return;
    }
    await refreshRedditCookies({
      profileDir: process.env.REDDIT_PROFILE_DIR,
      cookieFile: process.env.REDDIT_COOKIE_FILE,
    });
    json(res, 200, { ok: true });
    return;
  }
  if (!runtimeToken() || bearer(req) !== runtimeToken()) {
    json(res, 401, { error: "Unauthorized" });
    return;
  }
  if (req.method === "DELETE" && path.startsWith("/rpc/")) {
    const callId = decodeURIComponent(path.slice("/rpc/".length));
    calls.get(callId)?.abort();
    json(res, 202, { ok: true });
    return;
  }
  if (req.method !== "POST" || path !== "/rpc") {
    json(res, 404, { error: "Not Found" });
    return;
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    json(res, 400, {
      error: error instanceof Error ? error.message : "Invalid request",
    });
    return;
  }
  if (!validCall(body)) {
    json(res, 400, { error: "Invalid agent-reach request" });
    return;
  }
  if (calls.has(body.callId)) {
    json(res, 409, { error: "Agent-reach call is already active" });
    return;
  }
  const controller = new AbortController();
  const abortRequest = (): void => controller.abort();
  const abortResponse = (): void => {
    // A response close after a successful res.end() is normal. Only abort work
    // while this call still owns an unfinished response connection.
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abortRequest);
  res.once("close", abortResponse);
  calls.set(body.callId, controller);
  try {
    const result = await agentReachTool.execute(
      randomUUID(),
      { url: body.url },
      controller.signal,
    );
    if (!res.writableEnded && !res.destroyed) json(res, 200, { result });
  } catch (error) {
    if (!res.writableEnded && !res.destroyed) {
      json(res, 502, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    req.removeListener("aborted", abortRequest);
    res.removeListener("close", abortResponse);
    if (calls.get(body.callId) === controller) calls.delete(body.callId);
  }
}

export function createAgentReachRuntimeServer(): http.Server {
  return http.createServer((req, res) => {
    void handleAgentReachRuntimeRequest(req, res).catch((error) => {
      if (!res.headersSent)
        json(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createAgentReachRuntimeServer();
  process.once("SIGTERM", () => {
    for (const controller of calls.values()) controller.abort();
    server.close(() => process.exit(0));
  });
  server.listen(port, "0.0.0.0");
}
