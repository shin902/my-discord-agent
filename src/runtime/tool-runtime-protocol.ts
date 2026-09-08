import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export const TOOL_RUNTIME_MAX_BYTES = 64 * 1024 * 1024;
export const TOOL_RUNTIME_INPUT_MAX_BYTES = 1024 * 1024;
export type ToolRuntimeRequest =
  | { capability: string; args: unknown }
  | { maintenance: "reddit-cookie-refresh" };
export type ToolRuntimeResponse =
  | { result: AgentToolResult<unknown> }
  | { error: string };
