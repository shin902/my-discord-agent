import { randomUUID } from "node:crypto";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
  cancelAgentReachRuntime,
  executeAgentReachRuntime,
} from "../runtime/agent-reach-client.js";

const parameters = Type.Object({
  url: Type.String({ description: "URL to fetch." }),
});

/** Agent-facing metadata for the host-backed agent-reach capability. */
export const agentReachCapabilityTool: AgentTool<typeof parameters> = {
  name: "agent-reach",
  label: "Agent Reach",
  description:
    "Fetch information from YouTube, GitHub, Reddit, X, RSS, or general web pages and return it as Markdown. Always use this tool when retrieving information from URLs on those services.",
  parameters,
  execute: async (_toolCallId, { url }, signal) => {
    const callId = randomUUID();
    let cancellationRequested = false;
    const cancel = signal
      ? () => {
          if (cancellationRequested) return;
          cancellationRequested = true;
          void cancelAgentReachRuntime(callId);
        }
      : undefined;
    if (signal && cancel) {
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    }
    try {
      return await executeAgentReachRuntime(url, callId, signal);
    } finally {
      if (signal && cancel) signal.removeEventListener("abort", cancel);
    }
  },
};
