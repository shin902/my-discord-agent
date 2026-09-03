import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";

export interface ToolProxyEndpoint {
  url: string;
  token: string;
}

type ToolProxyResponse = {
  result?: AgentToolResult<unknown>;
  error?: unknown;
};

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
    if (!endpoint) {
      throw new Error(`Tool Proxy endpoint is unavailable for ${tool.name}`);
    }
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({
        capability: tool.name,
        args,
      }),
      signal,
    });
    let payload: ToolProxyResponse;
    try {
      payload = (await response.json()) as ToolProxyResponse;
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
    // Host weather results are complete (and intentionally small), so no
    // externalized output or shared volume is needed on this RPC path.
    void onUpdate;
    return payload.result;
  };

  return { ...tool, execute } as T;
}
