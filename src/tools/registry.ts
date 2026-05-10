import type { AgentTool } from "@mariozechner/pi-agent-core";
import { webfetchTool } from "./webfetch.js";

const TOOLS: Record<string, AgentTool> = {
  webfetch: webfetchTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
