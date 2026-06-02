import type { AgentTool } from "@earendil-works/pi-agent-core";
import { agentReachTool } from "./agent-reach.js";
import { bashTool } from "./bash.js";
import {
  editTool,
  globTool,
  grepTool,
  listTool,
  readTool,
  writeTool,
} from "./fs.js";
import { listEmailsTool, readEmailTool } from "./mail.js";

const TOOLS: Record<string, AgentTool> = {
  bash: bashTool,
  "agent-reach": agentReachTool,
  read: readTool,
  write: writeTool,
  list: listTool,
  edit: editTool,
  glob: globTool,
  grep: grepTool,
  list_emails: listEmailsTool,
  read_email: readEmailTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
