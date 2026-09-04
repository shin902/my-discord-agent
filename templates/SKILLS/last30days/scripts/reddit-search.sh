#!/bin/sh
# reddit-search.sh <TOPIC>
# Fetch Reddit search results through the least-privileged agent-reach Tool Proxy.
# The result is written to stdout so the Skill can consume it normally.
set -eu

TOPIC="${1:-}"
if [ -z "$TOPIC" ]; then
  echo "Usage: reddit-search.sh <TOPIC>" >&2
  exit 2
fi

: "${AGENT_REACH_TOOL_PROXY_URL:?AGENT_REACH_TOOL_PROXY_URL is not set}"
: "${AGENT_REACH_TOOL_PROXY_TOKEN:?AGENT_REACH_TOOL_PROXY_TOKEN is not set}"

case "$AGENT_REACH_TOOL_PROXY_URL" in
  http://host.docker.internal:*\/__tool-proxy/rpc|http://127.0.0.1:*\/__tool-proxy/rpc) ;;
  *) echo "invalid Tool Proxy endpoint" >&2; exit 1 ;;
esac

TOPIC="$TOPIC" node --input-type=module <<'NODE'
const endpoint = process.env.AGENT_REACH_TOOL_PROXY_URL;
const token = process.env.AGENT_REACH_TOOL_PROXY_TOKEN;
const topic = process.env.TOPIC;
const query = new URLSearchParams({
  q: topic,
  sort: "top",
  t: "month",
  limit: "10",
});
const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      capability: "agent-reach",
      args: {
        url: `https://www.reddit.com/search.json?${query.toString()}`,
      },
    }),
  },
);
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
NODE
