import { fileURLToPath } from "node:url";
import { refreshRedditCookies } from "../proxy/reddit-cookie-refresh.js";
import { refreshXCookies } from "../proxy/x-cookie-refresh.js";
import { getRuntimeCapability } from "../tools/runtime-capabilities.js";
import {
  TOOL_RUNTIME_INPUT_MAX_BYTES,
  TOOL_RUNTIME_MAX_BYTES,
  type ToolRuntimeResponse,
} from "./tool-runtime-protocol.js";

/** A single stdin request. Maintenance is only selected by the trusted host launcher. */
export async function executeRuntimeRequest(
  request: unknown,
): Promise<ToolRuntimeResponse> {
  try {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new Error("Invalid Tool Runtime request");
    const input = request as Record<string, unknown>;
    if (Object.keys(input).length === 1 && "maintenance" in input) {
      const maintenance = input.maintenance;
      const isReddit = maintenance === "reddit-cookie-refresh";
      const isX = maintenance === "x-cookie-refresh";
      if (!isReddit && !isX) throw new Error("Invalid Tool Runtime request");
      const profileDir = isReddit
        ? process.env.REDDIT_PROFILE_DIR
        : process.env.X_PROFILE_DIR;
      const cookieFile = isReddit
        ? process.env.REDDIT_COOKIE_FILE
        : process.env.X_COOKIE_FILE;
      if (!profileDir || !cookieFile)
        throw new Error(
          `${isReddit ? "Reddit" : "X"} maintenance state is unavailable`,
        );
      // Browser diagnostics may contain private state; only the fixed outcome is returned.
      try {
        if (isReddit) await refreshRedditCookies({ profileDir, cookieFile });
        else await refreshXCookies({ profileDir, cookieFile });
      } catch (error) {
        console.error(
          `[tool-runtime] ${isReddit ? "Reddit" : "X"} cookie refresh failed:`,
          error,
        );
        throw new Error(
          `${isReddit ? "Reddit" : "X"} cookie refresh failed; check login and Runtime diagnostics`,
        );
      }
      return {
        result: {
          content: [
            {
              type: "text",
              text: `${isReddit ? "Reddit" : "X"} cookies refreshed`,
            },
          ],
          details: {},
        },
      };
    }
    if (
      Object.keys(input).length !== 2 ||
      typeof input.capability !== "string" ||
      !Object.hasOwn(input, "args")
    )
      throw new Error("Invalid Tool Runtime request");
    const capability = getRuntimeCapability(input.capability);
    if (!capability?.validateArgs(input.args))
      throw new Error("Invalid Runtime capability or arguments");
    const tool = capability.factory();
    if (!tool) throw new Error("Runtime capability unavailable");
    // Arguments are already materialized and (when configured) approved by the
    // Proxy. Do not recompute clock-dependent defaults after approval.
    return {
      result: await tool.execute(
        "tool-runtime",
        input.args,
        AbortSignal.timeout(capability.timeoutMs),
      ),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Tool Runtime failed",
    };
  }
}

export async function main(): Promise<void> {
  let response: ToolRuntimeResponse;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > TOOL_RUNTIME_INPUT_MAX_BYTES)
        throw new Error("Tool Runtime request too large");
      chunks.push(buffer);
    }
    response = await executeRuntimeRequest(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } catch {
    response = { error: "Invalid Tool Runtime input" };
  }
  let output = JSON.stringify(response);
  if (Buffer.byteLength(output) > TOOL_RUNTIME_MAX_BYTES)
    output = JSON.stringify({ error: "Tool Runtime result too large" });
  process.stdout.write(output);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main();
