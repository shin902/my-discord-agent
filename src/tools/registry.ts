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
  list_emails: listEmailsTool,
  read_email: readEmailTool,
  list_events: listEventsTool,
  read_event: readEventTool,
  create_event: createEventTool,
  update_event: updateEventTool,
  delete_event: deleteEventTool,
  browserless_smart_scrape: browserlessSmartScrapeTool,
  browserless_search: browserlessSearchTool,
  browserless_function: browserlessFunctionTool,
  browserless_content: browserlessContentTool,
  tavily_search: tavilySearchTool,
  tavily_extract: tavilyExtractTool,
  tavily_crawl: tavilyCrawlTool,
  tavily_map: tavilyMapTool,
  get_current_weather: getCurrentWeatherTool,
  get_weather_forecast: getWeatherForecastTool,
};

export function resolveTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}
