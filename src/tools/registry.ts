import type { AgentTool } from "@earendil-works/pi-agent-core";
import { editTool, listTool, readTool, writeTool } from "./fs.js";
import { sandboxTool } from "./sandbox.js";
import { webfetchTool } from "./webfetch.js";

const TOOLS: Record<string, AgentTool> = {
  webfetch: webfetchTool,
  sandbox: sandboxTool,
  read: readTool,
  write: writeTool,
  list: listTool,
  edit: editTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
