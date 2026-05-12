import type { AgentTool } from "@earendil-works/pi-agent-core";
import { sandboxTool } from "./sandbox.js";
import { webfetchTool } from "./webfetch.js";

const TOOLS: Record<string, AgentTool> = {
  webfetch: webfetchTool,
  sandbox: sandboxTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
