import { fileURLToPath } from "node:url";
import { getRuntimeCapability } from "../tools/runtime-capabilities.js";
import {
  TOOL_RUNTIME_INPUT_MAX_BYTES,
  TOOL_RUNTIME_MAX_BYTES,
  type ToolRuntimeResponse,
} from "./tool-runtime-protocol.js";

/** A single capability request from the trusted host. */
export async function executeRuntimeRequest(
  request: unknown,
): Promise<ToolRuntimeResponse> {
  try {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new Error("Invalid Tool Runtime request");
    const input = request as Record<string, unknown>;
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
      result: await tool.execute("tool-runtime", input.args),
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
