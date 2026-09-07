#!/bin/sh
set -eu

# Fetch a public research endpoint through the least-privileged Agent Reach
# Tool Proxy capability.  This is deliberately a separate thin frontend from
# the Reddit-specific formatter below; both preserve stdout/redirection.
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: agent-reach-fetch.sh <URL>" >&2
  exit 2
fi

: "${AGENT_REACH_TOOL_PROXY_URL:?AGENT_REACH_TOOL_PROXY_URL is not set}"
: "${AGENT_REACH_TOOL_PROXY_TOKEN:?AGENT_REACH_TOOL_PROXY_TOKEN is not set}"
case "$AGENT_REACH_TOOL_PROXY_URL" in
  http://host.docker.internal:*\/__tool-proxy/rpc|http://127.0.0.1:*\/__tool-proxy/rpc) ;;
  *) echo "invalid Tool Proxy endpoint" >&2; exit 1 ;;
esac

AGENT_REACH_URL="$1" node --input-type=module <<'NODE'
const endpoint = process.env.AGENT_REACH_TOOL_PROXY_URL;
const token = process.env.AGENT_REACH_TOOL_PROXY_TOKEN;
const url = process.env.AGENT_REACH_URL;
try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ capability: "agent-reach", args: { url } }),
  });
  let payload;
  try {
    payload = await response.json();
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
  const text = payload.result.content?.find((part) => part.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Tool Proxy returned no text result");
  process.stdout.write(text);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
NODE
