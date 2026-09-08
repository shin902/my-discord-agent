#!/usr/bin/env node
import { requestToolProxy } from "../tools/tool-proxy.js";

/** Generic capability transport. It neither selects executors nor issues authority. */
async function main(args = process.argv.slice(2)): Promise<void> {
  try {
    if (args.length !== 2)
      throw new Error("Usage: tool-proxy <capability> <JSON arguments>");
    const url = process.env.TOOL_PROXY_URL;
    const token = process.env.TOOL_PROXY_TOKEN;
    if (!url || !token)
      throw new Error(
        "Tool Proxy endpoint is unavailable; update the host and Runner image",
      );
    const endpoint = new URL(url);
    if (
      endpoint.protocol !== "http:" ||
      !["host.docker.internal", "127.0.0.1"].includes(endpoint.hostname) ||
      endpoint.pathname !== "/__tool-proxy/rpc" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("Invalid Tool Proxy endpoint");
    const result = await requestToolProxy(args[0], JSON.parse(args[1]), {
      url,
      token,
    });
    const parts = result.content.filter((part) => part.type === "text");
    if (parts.length === 0)
      throw new Error("Tool Proxy returned no text result");
    process.stdout.write(parts.map((part) => part.text).join(""));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Tool Proxy failed");
    process.exitCode = 1;
  }
}

void main();
