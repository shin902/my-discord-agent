#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess


TOOL_PROXY_NODE_SCRIPT = r'''
const endpoint = process.env.AGENT_REACH_TOOL_PROXY_URL;
const token = process.env.AGENT_REACH_TOOL_PROXY_TOKEN;
const args = JSON.parse(process.env.TOOL_PROXY_ARGS ?? "{}");

try {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ capability: "arxiv-survey", args }),
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
'''


def call_tool_proxy(arguments: dict[str, object]) -> None:
    endpoint = os.environ.get("AGENT_REACH_TOOL_PROXY_URL")
    token = os.environ.get("AGENT_REACH_TOOL_PROXY_TOKEN")
    if not endpoint or not token:
        raise RuntimeError("Agent Reach Tool Proxy endpoint is not configured")
    if not (
        (
            endpoint.startswith("http://host.docker.internal:")
            or endpoint.startswith("http://127.0.0.1:")
        )
        and endpoint.endswith("/__tool-proxy/rpc")
    ):
        raise RuntimeError("invalid Tool Proxy endpoint")

    env = os.environ.copy()
    env["TOOL_PROXY_ARGS"] = json.dumps(arguments, separators=(",", ":"))
    result = subprocess.run(
        ["node", "--input-type=module", "-e", TOOL_PROXY_NODE_SCRIPT],
        env=env,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main() -> None:
    parser = argparse.ArgumentParser(description="Survey arXiv through Tool Proxy")
    parser.add_argument("queries", nargs="+", help="1-8 natural-language search queries")
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")
    parser.add_argument("--limit", type=int, choices=range(1, 51), default=30)
    parser.add_argument(
        "--sort",
        choices=("relevance", "submitted", "updated"),
        default="submitted",
    )
    args = parser.parse_args()
    if len(args.queries) > 8:
        parser.error("at most 8 queries may be supplied")

    tool_args: dict[str, object] = {
        "queries": args.queries,
        "max_results": args.limit,
        "sort": args.sort,
    }
    if args.from_date is not None:
        tool_args["from"] = args.from_date
    if args.to_date is not None:
        tool_args["to"] = args.to_date
    try:
        call_tool_proxy(tool_args)
    except RuntimeError as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
