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
  listCalendarsTool,
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

export type AgentToolFactory = () => AgentTool | undefined;

const createStaticToolFactory =
  (tool: AgentTool): AgentToolFactory =>
  () =>
    wrapToolOutput(tool);

const TOOL_FACTORIES = {
  bash: createStaticToolFactory(bashTool),
  date: createStaticToolFactory(dateTool),
  "agent-reach": createStaticToolFactory(agentReachTool),
  "arxiv-search": createStaticToolFactory(arxivSearchTool),
  "arxiv-survey": createStaticToolFactory(arxivSurveyTool),
  read: createStaticToolFactory(readTool),
  write: createStaticToolFactory(writeTool),
  list: createStaticToolFactory(listTool),
  edit: createStaticToolFactory(editTool),
  glob: createStaticToolFactory(globTool),
  grep: createStaticToolFactory(grepTool),
  "list-emails": createStaticToolFactory(listEmailsTool),
  "read-email": createStaticToolFactory(readEmailTool),
  "list-issues": createStaticToolFactory(listIssuesTool),
  "read-issue": createStaticToolFactory(readIssueTool),
  "list-issue-comments": createStaticToolFactory(listIssueCommentsTool),
  "list-pull-request-comments": createStaticToolFactory(
    listPullRequestCommentsTool,
  ),
  "read-pull-request": createStaticToolFactory(readPullRequestTool),
  "comment-issue": createStaticToolFactory(commentIssueTool),
  "clone-repository": createStaticToolFactory(cloneRepositoryTool),
  "list-calendars": createStaticToolFactory(listCalendarsTool),
  "list-events": createStaticToolFactory(listEventsTool),
  "read-event": createStaticToolFactory(readEventTool),
  "create-event": createStaticToolFactory(createEventTool),
  "update-event": createStaticToolFactory(updateEventTool),
  "delete-event": createStaticToolFactory(deleteEventTool),
  "browserless-smart-scrape": createStaticToolFactory(
    browserlessSmartScrapeTool,
  ),
  "browserless-search": createStaticToolFactory(browserlessSearchTool),
  "browserless-function": createStaticToolFactory(browserlessFunctionTool),
  "browserless-content": createStaticToolFactory(browserlessContentTool),
  "tavily-search": createStaticToolFactory(tavilySearchTool),
  "tavily-extract": createStaticToolFactory(tavilyExtractTool),
  "tavily-crawl": createStaticToolFactory(tavilyCrawlTool),
  "tavily-map": createStaticToolFactory(tavilyMapTool),
  "get-current-weather": createStaticToolFactory(getCurrentWeatherTool),
  "get-weather-forecast": createStaticToolFactory(getWeatherForecastTool),
  bot: () => undefined,
  subagent: () => undefined,
} satisfies Record<string, AgentToolFactory>;

type ToolName = keyof typeof TOOL_FACTORIES;
type RuntimeToolFactories = Partial<Record<ToolName, AgentToolFactory>>;

export function resolveTools(
  toolNames: string[],
  runtimeFactories: RuntimeToolFactories = {},
): AgentTool[] {
  return toolNames.flatMap((name) => {
    const defaultFactory = TOOL_FACTORIES[name as ToolName];
    if (!defaultFactory) throw new Error(`不明なツール名: ${name}`);
    const tool = (runtimeFactories[name as ToolName] ?? defaultFactory)();
    return tool ? [tool] : [];
  });
}
