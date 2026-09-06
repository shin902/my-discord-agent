import type { AgentToolResult } from "@earendil-works/pi-agent-core";

export interface AgentReachRuntimeResponse {
  result?: AgentToolResult<unknown>;
  error?: unknown;
}

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8787";

function runtimeUrl(): string {
  return (process.env.AGENT_REACH_RUNTIME_URL ?? DEFAULT_RUNTIME_URL).replace(
    /\/$/,
    "",
  );
}

function runtimeToken(): string {
  const token = process.env.AGENT_REACH_RUNTIME_TOKEN;
  if (!token) throw new Error("Agent Reach Tool Runtime token is unavailable");
  return token;
}

/** Execute the dedicated agent-reach runtime without exposing its filesystem. */
export async function executeAgentReachRuntime(
  url: string,
  callId: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<unknown>> {
  const response = await fetch(`${runtimeUrl()}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${runtimeToken()}`,
    },
    body: JSON.stringify({ callId, url }),
    signal,
  });
  let payload: AgentReachRuntimeResponse;
  try {
    payload = (await response.json()) as AgentReachRuntimeResponse;
  } catch {
    throw new Error(
      `Agent Reach Tool Runtime request failed (HTTP ${response.status})`,
    );
  }
  if (!response.ok || payload.result === undefined) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : `Agent Reach Tool Runtime request failed (HTTP ${response.status})`,
    );
  }
  return payload.result;
}

export async function cancelAgentReachRuntime(callId: string): Promise<void> {
  await fetch(`${runtimeUrl()}/rpc/${encodeURIComponent(callId)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${runtimeToken()}` },
  }).catch(() => undefined);
}
