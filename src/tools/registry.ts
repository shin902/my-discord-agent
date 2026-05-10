import type { AgentTool } from "@earendil-works/pi-agent-core";
import { editTool } from "./edit.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { readTool } from "./read.js";
import { treeTool } from "./tree.js";
import { webfetchTool } from "./webfetch.js";
import { writeTool } from "./write.js";

const TOOLS: Record<string, AgentTool> = {
  webfetch: webfetchTool,
  read: readTool,
  write: writeTool,
  edit: editTool,
  list: listTool,
  tree: treeTool,
  grep: grepTool,
  glob: globTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
