import type { AgentTool } from "@earendil-works/pi-agent-core";
import { agentReachTool } from "./agent-reach.js";
import { arxivSearchTool, arxivSurveyTool } from "./arxiv.js";
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
import { dateTool } from "./date.js";
import {
  editTool,
  globTool,
  grepTool,
  listTool,
  readTool,
  writeTool,
} from "./fs.js";
import { cloneRepositoryTool } from "./git.js";
import {
  commentIssueTool,
  listIssueCommentsTool,
  listIssuesTool,
  listPullRequestCommentsTool,
  readIssueTool,
  readPullRequestTool,
} from "./github.js";
import { listEmailsTool, readEmailTool } from "./mail.js";
import { wrapToolOutput } from "./output.js";
import {
  tavilyCrawlTool,
  tavilyExtractTool,
  tavilyMapTool,
  tavilySearchTool,
} from "./tavily.js";
import { getCurrentWeatherTool, getWeatherForecastTool } from "./weather.js";

// Context-created tools are validated here but instantiated by their runtime
// owner, not by the static registry.
const CONTEXT_CREATED_TOOLS = new Set(["bot", "subagent"]);

const TOOLS: Record<string, AgentTool> = {
  bash: bashTool,
  date: dateTool,
  "agent-reach": agentReachTool,
  "arxiv-search": arxivSearchTool,
  "arxiv-survey": arxivSurveyTool,
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
  "list-issue-comments": listIssueCommentsTool,
  "list-pull-request-comments": listPullRequestCommentsTool,
  "read-pull-request": readPullRequestTool,
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
    if (CONTEXT_CREATED_TOOLS.has(name)) return [];
    const tool = TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [wrapToolOutput(tool)];
  });
}
