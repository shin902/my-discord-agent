import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as http from "node:http";
import { executeToolRuntime } from "../runtime/tool-runtime-client.js";
import { materializeCapabilityArgs } from "../tools/capability.js";
import { getCapabilityDefinition } from "../tools/registry.js";
import {
  createToolApprovalRequest,
  type ToolApprovalRequest,
} from "./tool-approval.js";

export const TOOL_PROXY_PATH = "/__tool-proxy/rpc";
// Keep enough room for large Calendar descriptions and recurrence rules while
// retaining a finite limit against accidentally unbounded request bodies.
export const TOOL_PROXY_BODY_LIMIT = 1024 * 1024;
export interface TrustedDiscordDestination {
  readonly botId: string;
  readonly channelId: string;
}

type ToolProxyRunSnapshot = Readonly<{
  runId: string;
  allowedCapabilities: readonly string[];
  approvalRequiredCapabilities: readonly string[];
  trustedDiscordDestination: TrustedDiscordDestination | undefined;
  revokeSignal: AbortSignal;
  revoke: () => void;
}>;

const runs = new Map<string, ToolProxyRunSnapshot>();
let toolProxyPort: number | null = null;
let toolProxyServer: http.Server | undefined;

export interface ToolProxyRunConfig {
  url: string;
  token: string;
  revoke: () => void;
}

/** Register one short-lived run authority in host memory. */
export function createToolProxyRun(
  runId: string,
  allowedCapabilities: Iterable<string>,
  options: {
    approvalRequiredCapabilities?: Iterable<string>;
    trustedDiscordDestination?: TrustedDiscordDestination;
  } = {},
): ToolProxyRunConfig | undefined {
  if (toolProxyPort === null) return undefined;

  const allowed = Object.freeze([...allowedCapabilities]);
  const approvalRequired = Object.freeze([
    ...(options.approvalRequiredCapabilities ?? []),
  ]);
  for (const capability of approvalRequired) {
    if (!allowed.includes(capability)) {
      throw new Error(
        `Approval-required capability is not allowed for this run: ${capability}`,
      );
    }
  }

  const controller = new AbortController();
  const token = randomBytes(32).toString("base64url");
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    runs.delete(token);
    controller.abort(new Error("Run authority revoked"));
  };
  const snapshot = Object.freeze({
    runId,
    allowedCapabilities: allowed,
    approvalRequiredCapabilities: approvalRequired,
    trustedDiscordDestination: options.trustedDiscordDestination
      ? Object.freeze({ ...options.trustedDiscordDestination })
      : undefined,
    revokeSignal: controller.signal,
    revoke,
  });
  runs.set(token, snapshot);
  return {
    url: `http://host.docker.internal:${toolProxyPort}${TOOL_PROXY_PATH}`,
    token,
    revoke,
  };
}

export function getToolProxyPort(): number {
  if (toolProxyPort === null)
    throw new Error("Tool Proxy server は未初期化です");
  return toolProxyPort;
}

export function activeToolProxyRunCount(): number {
  return runs.size;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const serialized = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
  });
  res.end(serialized);
}

function bearerToken(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (typeof value !== "string") return undefined;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1];
}

async function readBody(
  req: IncomingMessage,
  onBodyReadReady?: () => void,
): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer | string) => {
      if (tooLarge) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > TOOL_PROXY_BODY_LIMIT) {
        tooLarge = true;
        return;
      }
      chunks.push(buffer);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(new Error("request body too large"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
    onBodyReadReady?.();
  });
}

function isRequest(value: unknown): value is {
  capability: string;
  args: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    typeof (value as Record<string, unknown>).capability === "string" &&
    Object.hasOwn(value, "args")
  );
}

export type ToolApprovalPresenter = (
  request: ToolApprovalRequest,
) => Promise<void>;

export interface ToolProxyRequestHandlerOptions {
  /** Test synchronization point after authentication and body listeners are ready. */
  onBodyReadReady?: () => void;
  /** Application adapter for presenting approval without coupling Proxy to Discord. */
  presentApprovalRequest?: ToolApprovalPresenter;
}

function runIsCurrent(
  token: string,
  run: ToolProxyRunSnapshot,
  capability: string,
): boolean {
  return (
    runs.get(token) === run &&
    !run.revokeSignal.aborted &&
    run.allowedCapabilities.includes(capability) &&
    run.approvalRequiredCapabilities.includes(capability)
  );
}

function approvalFailure(
  res: ServerResponse,
  token: string,
  run: ToolProxyRunSnapshot,
  capability: string,
): void {
  if (runs.get(token) !== run || run.revokeSignal.aborted) {
    sendJson(res, 401, { error: "Unknown or expired run token" });
    return;
  }
  sendJson(res, 403, { error: `Tool approval failed: ${capability}` });
}

async function executeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: ToolProxyRequestHandlerOptions,
): Promise<void> {
  if (req.method !== "POST" || req.url?.split("?", 1)[0] !== TOOL_PROXY_PATH) {
    sendJson(res, 404, { error: "Not Found" });
    return;
  }

  const contentType = req.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return;
  }

  const token = bearerToken(req);
  if (!token) {
    sendJson(res, 401, { error: "Missing or malformed bearer token" });
    return;
  }
  const run = runs.get(token);
  if (!run) {
    sendJson(res, 401, { error: "Unknown or expired run token" });
    return;
  }

  let body: unknown;
  try {
    body = await readBody(req, options.onBodyReadReady);
  } catch (error) {
    sendJson(
      res,
      error instanceof Error && error.message === "request body too large"
        ? 413
        : 400,
      {
        error: error instanceof Error ? error.message : "Invalid request body",
      },
    );
    return;
  }
  if (!isRequest(body)) {
    sendJson(res, 400, { error: "Invalid Tool Proxy request" });
    return;
  }
  if (runs.get(token) !== run) {
    sendJson(res, 401, { error: "Unknown or expired run token" });
    return;
  }
  const capability = getCapabilityDefinition(body.capability);
  if (!capability) {
    sendJson(res, 404, { error: `Unknown capability: ${body.capability}` });
    return;
  }
  if (capability.executor === "sandbox") {
    sendJson(res, 403, {
      error: `Capability is not a Proxy capability: ${body.capability}`,
    });
    return;
  }
  if (!run.allowedCapabilities.includes(body.capability)) {
    sendJson(res, 403, {
      error: `Capability is not authorized: ${body.capability}`,
    });
    return;
  }
  if (!capability.validateArgs(body.args)) {
    sendJson(res, 400, {
      error: `Invalid arguments for capability: ${body.capability}`,
    });
    return;
  }
  const effectiveArgs = materializeCapabilityArgs(capability, body.args);
  const abortController = new AbortController();
  const abortRequest = (): void => {
    if (!res.writableEnded) abortController.abort();
  };
  req.once("aborted", abortRequest);
  res.once("close", abortRequest);
  const signal = AbortSignal.any([abortController.signal, run.revokeSignal]);
  if (req.aborted || res.destroyed) abortRequest();
  try {
    let executionArgs = effectiveArgs;

    if (run.approvalRequiredCapabilities.includes(body.capability)) {
      if (!run.trustedDiscordDestination || !options.presentApprovalRequest) {
        approvalFailure(res, token, run, body.capability);
        return;
      }

      let approvalRequest: ToolApprovalRequest | undefined;
      try {
        approvalRequest = createToolApprovalRequest(
          {
            runId: run.runId,
            capability: body.capability,
            trustedDiscordDestination: run.trustedDiscordDestination,
            revokeSignal: signal,
          },
          effectiveArgs,
        );
        await options.presentApprovalRequest(approvalRequest);
        const decision = await approvalRequest.waitForDecision();
        if (decision !== "approved") {
          approvalFailure(res, token, run, body.capability);
          return;
        }
      } catch (error) {
        approvalRequest?.claim("deny")?.failUiUpdate(error);
        approvalFailure(res, token, run, body.capability);
        return;
      }

      if (!runIsCurrent(token, run, body.capability)) {
        sendJson(res, 401, { error: "Unknown or expired run token" });
        return;
      }
      executionArgs = approvalRequest.invocation.args.value;
    }

    const tool = capability.factory();
    if (!tool) {
      sendJson(res, 500, {
        error: `Host capability is unavailable: ${body.capability}`,
      });
      return;
    }
    signal.throwIfAborted();
    const result =
      capability.executor === "runtime"
        ? await executeToolRuntime(body.capability, executionArgs, signal)
        : await tool.execute("tool-proxy", executionArgs, signal);
    if (!res.writableEnded) sendJson(res, 200, { result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!res.destroyed && !res.writableEnded)
      sendJson(res, 502, { error: message });
  } finally {
    req.off("aborted", abortRequest);
    res.off("close", abortRequest);
  }
}

export function createToolProxyRequestHandler(
  options: ToolProxyRequestHandlerOptions = {},
) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void executeRequest(req, res, options).catch((_error) => {
      if (!res.headersSent)
        sendJson(res, 500, { error: "Internal Server Error" });
    });
  };
}

export async function initToolProxyServer(
  options: ToolProxyRequestHandlerOptions = {},
): Promise<number> {
  if (toolProxyPort !== null) return toolProxyPort;
  const server = http.createServer(createToolProxyRequestHandler(options));
  toolProxyServer = server;
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "0.0.0.0", () => {
      toolProxyPort = (server.address() as { port: number }).port;
      resolve();
    });
  });
  return getToolProxyPort();
}

/** Close admission and revoke all run authorities before host shutdown. */
export async function stopToolProxyServer(): Promise<void> {
  const server = toolProxyServer;
  toolProxyServer = undefined;
  toolProxyPort = null;
  for (const run of [...runs.values()]) run.revoke();
  if (server) {
    const closed = new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    server.closeAllConnections();
    await closed;
  }
}
