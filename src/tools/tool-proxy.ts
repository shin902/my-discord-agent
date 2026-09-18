import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { externalizeLargeToolResult } from "./output.js";

export interface ToolProxyEndpoint {
  url: string;
  token: string;
}

type ToolProxyResponse<T> = {
  result?: T;
  error?: unknown;
};

export type ToolContract = Pick<
  AgentTool,
  "name" | "description" | "parameters"
>;

export function describeToolProxy(
  capability: string,
  endpoint?: ToolProxyEndpoint,
  signal?: AbortSignal,
): Promise<ToolContract> {
  return requestProxy({ capability, operation: "describe" }, endpoint, signal);
}

export function requestToolProxy(
  capability: string,
  args: unknown,
  endpoint?: ToolProxyEndpoint,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  return requestProxy({ capability, args }, endpoint, signal);
}

async function requestProxy<T>(
  body:
    | { capability: string; args: unknown }
    | { capability: string; operation: "describe" },
  endpoint?: ToolProxyEndpoint,
  signal?: AbortSignal,
): Promise<T> {
  if (!endpoint) {
    throw new Error(
      `Tool Proxy endpoint is unavailable for ${body.capability}`,
    );
  }
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${endpoint.token}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  let payload: ToolProxyResponse<T>;
  try {
    payload = (await response.json()) as ToolProxyResponse<T>;
  } catch {
    throw new Error(`Tool Proxy request failed (HTTP ${response.status})`);
  }
  if (!response.ok || payload.result === undefined) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Tool Proxy request failed (HTTP ${response.status})`,
    );
  }
  return payload.result;
}

/** Create an agent-facing tool that delegates execution to the host Tool Proxy. */
export function createToolProxyTool<T extends AgentTool>(
  tool: T,
  endpoint?: ToolProxyEndpoint,
): T {
  const execute = async (
    _toolCallId: string,
    args: unknown,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback,
  ): Promise<AgentToolResult<unknown>> => {
    const result = await requestToolProxy(tool.name, args, endpoint, signal);
    void onUpdate;
    return externalizeLargeToolResult(result);
  };

  return { ...tool, execute } as T;
}
