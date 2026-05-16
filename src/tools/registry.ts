import type { AgentTool } from "@earendil-works/pi-agent-core";
import { bashTool } from "./bash.js";
import {
  editTool,
  globTool,
  grepTool,
  listTool,
  readTool,
  writeTool,
} from "./fs.js";
import { urlFetchTool } from "./url-fetch.js";
import { webfetchTool } from "./webfetch.js";

const TOOLS: Record<string, AgentTool> = {
  bash: bashTool,
  webfetch: webfetchTool,
  "url-fetch": urlFetchTool,
  read: readTool,
  write: writeTool,
  list: listTool,
  edit: editTool,
  glob: globTool,
  grep: grepTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
