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
import {
  type AgentToolFactory,
  type CapabilityDefinition,
  dispatchCapability,
} from "./capability.js";
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

const createStaticToolFactory =
  (tool: AgentTool): AgentToolFactory =>
  () =>
    wrapToolOutput(tool);

const TOOL_FACTORIES = {
  bash: createStaticToolFactory(bashTool),
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

const CAPABILITIES = {
  date: {
    tool: "date",
    executor: "sandbox",
    factory: createStaticToolFactory(dateTool),
  },
} satisfies Record<string, CapabilityDefinition>;

type ToolName = keyof typeof TOOL_FACTORIES;

export type { AgentToolFactory } from "./capability.js";

export type RuntimeToolName = "bot" | "subagent";
export type RuntimeToolFactories = Partial<
  Record<RuntimeToolName, AgentToolFactory>
>;

function isRuntimeToolName(name: string): name is RuntimeToolName {
  return name === "bot" || name === "subagent";
}

export function resolveTools(
  toolNames: string[],
  runtimeFactories: RuntimeToolFactories = {},
): AgentTool[] {
  const staticTools: AgentTool[] = [];

  for (const name of toolNames) {
    const capability = CAPABILITIES[name as keyof typeof CAPABILITIES];
    if (capability) {
      const tool = dispatchCapability(capability);
      if (tool) staticTools.push(tool);
      continue;
    }

    const factory = TOOL_FACTORIES[name as ToolName];
    if (!factory) throw new Error(`不明なツール名: ${name}`);
    if (!isRuntimeToolName(name)) {
      const tool = factory();
      if (tool) staticTools.push(tool);
    }
  }

  const runtimeTools: AgentTool[] = [];
  if (toolNames.includes("subagent")) {
    const tool = (runtimeFactories.subagent ?? TOOL_FACTORIES.subagent)();
    if (tool) runtimeTools.push(tool);
  }
  if (toolNames.includes("bot")) {
    const tool = (runtimeFactories.bot ?? TOOL_FACTORIES.bot)();
    if (tool) runtimeTools.push(tool);
  }

  return [...staticTools, ...runtimeTools];
}
