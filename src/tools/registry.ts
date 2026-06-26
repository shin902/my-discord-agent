import type { AgentTool } from "@earendil-works/pi-agent-core";
import { agentReachTool } from "./agent-reach.js";
import { bashTool } from "./bash.js";
import {
  browserlessContentTool,
  browserlessFunctionTool,
  browserlessSearchTool,
  browserlessSmartScrapeTool,
} from "./browserless.js";
import {
  createEventTool,
  deleteEventTool,
  listEventsTool,
  readEventTool,
  updateEventTool,
} from "./calendar.js";
import {
  editTool,
  globTool,
  grepTool,
  listTool,
  readTool,
  writeTool,
} from "./fs.js";
import { cloneRepositoryTool } from "./git.js";
import { commentIssueTool, listIssuesTool, readIssueTool } from "./github.js";
import { listEmailsTool, readEmailTool } from "./mail.js";
import {
  tavilyCrawlTool,
  tavilyExtractTool,
  tavilyMapTool,
  tavilySearchTool,
} from "./tavily.js";
import { getCurrentWeatherTool, getWeatherForecastTool } from "./weather.js";

const TOOLS: Record<string, AgentTool> = {
  bash: bashTool,
  "agent-reach": agentReachTool,
  read: readTool,
  write: writeTool,
  list: listTool,
  edit: editTool,
  glob: globTool,
  grep: grepTool,
  "list-emails": listEmailsTool,
  "read-email": readEmailTool,
  "list-issues": listIssuesTool,
  "read-issue": readIssueTool,
  "comment-issue": commentIssueTool,
  "clone-repository": cloneRepositoryTool,
  "list-events": listEventsTool,
  "read-event": readEventTool,
  "create-event": createEventTool,
  "update-event": updateEventTool,
  "delete-event": deleteEventTool,
  "browserless-smart-scrape": browserlessSmartScrapeTool,
  "browserless-search": browserlessSearchTool,
  "browserless-function": browserlessFunctionTool,
  "browserless-content": browserlessContentTool,
  "tavily-search": tavilySearchTool,
  "tavily-extract": tavilyExtractTool,
  "tavily-crawl": tavilyCrawlTool,
  "tavily-map": tavilyMapTool,
  "get-current-weather": getCurrentWeatherTool,
  "get-weather-forecast": getWeatherForecastTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
