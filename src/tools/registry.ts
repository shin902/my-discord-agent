import type { AgentTool } from "@earendil-works/pi-agent-core";
import { agentReachCapabilityTool } from "./agent-reach-capability.js";
import { arxivSearchTool, arxivSurveyTool } from "./arxiv.js";
import { bashTool } from "./bash.js";
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
  type CapabilityArgsValidator,
  type CapabilityDefinition,
  type CapabilityDispatchContext,
  dispatchCapability,
  materializeToolArgs,
  validateToolArgs,
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
import { tavilySearchTool } from "./tavily.js";
import { getCurrentWeatherTool, getWeatherForecastTool } from "./weather.js";

const createStaticToolFactory =
  (tool: AgentTool): AgentToolFactory =>
  () =>
    wrapToolOutput(tool);

const TOOL_FACTORIES = {
  bash: createStaticToolFactory(bashTool),
  read: createStaticToolFactory(readTool),
  write: createStaticToolFactory(writeTool),
  list: createStaticToolFactory(listTool),
  edit: createStaticToolFactory(editTool),
  glob: createStaticToolFactory(globTool),
  grep: createStaticToolFactory(grepTool),
  bot: () => undefined,
  subagent: () => undefined,
} satisfies Record<string, AgentToolFactory>;

const isObjectArgs = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const currentWeatherArgsValidator: CapabilityArgsValidator = (value) =>
  isObjectArgs(value) && typeof value.location === "string";

const weatherForecastArgsValidator: CapabilityArgsValidator = (value) =>
  isObjectArgs(value) &&
  typeof value.location === "string" &&
  (value.days === undefined ||
    (typeof value.days === "number" && Number.isSafeInteger(value.days)));

const tavilySearchArgsValidator: CapabilityArgsValidator = (value) =>
  isObjectArgs(value) &&
  typeof value.query === "string" &&
  (value.max_results === undefined ||
    (typeof value.max_results === "number" &&
      Number.isSafeInteger(value.max_results) &&
      value.max_results >= 1 &&
      value.max_results <= 10)) &&
  (value.search_depth === undefined ||
    value.search_depth === "basic" ||
    value.search_depth === "advanced") &&
  (value.include_answer === undefined ||
    typeof value.include_answer === "boolean") &&
  (value.topic === undefined ||
    value.topic === "general" ||
    value.topic === "news" ||
    value.topic === "finance");

interface HostCapabilityOptions {
  readonly validateArgs?: CapabilityArgsValidator;
  readonly clampedProperties?: readonly string[];
  readonly defaultArgs?: () => Readonly<Record<string, unknown>>;
}

function hostCapability(
  tool: AgentTool,
  options: HostCapabilityOptions = {},
): CapabilityDefinition {
  const clampedProperties = options.clampedProperties ?? [];
  return {
    tool: tool.name,
    executor: "host",
    factory: () => tool,
    validateArgs:
      options.validateArgs ?? validateToolArgs(tool, clampedProperties),
    materializeArgs: materializeToolArgs(tool, {
      defaultArgs: options.defaultArgs,
      clampedProperties,
    }),
  };
}

const CAPABILITIES = {
  date: {
    tool: "date",
    executor: "sandbox",
    factory: createStaticToolFactory(dateTool),
  },
  "get-current-weather": hostCapability(getCurrentWeatherTool, {
    validateArgs: currentWeatherArgsValidator,
  }),
  "get-weather-forecast": hostCapability(getWeatherForecastTool, {
    validateArgs: weatherForecastArgsValidator,
    clampedProperties: ["days"],
    defaultArgs: () => ({ days: 3 }),
  }),
  // Host results cross the Tool Proxy as raw data; the sandbox-side thin
  // proxy applies the common output boundary after receiving them.
  "tavily-search": hostCapability(tavilySearchTool, {
    validateArgs: tavilySearchArgsValidator,
    clampedProperties: ["max_results"],
    defaultArgs: () => ({
      max_results: 5,
      search_depth: "basic",
      include_answer: true,
      topic: "general",
    }),
  }),
  "arxiv-search": hostCapability(arxivSearchTool, {
    clampedProperties: ["max_results"],
    defaultArgs: () => ({ max_results: 10, sort: "relevance" }),
  }),
  "arxiv-survey": hostCapability(arxivSurveyTool, {
    clampedProperties: ["max_results"],
    defaultArgs: () => ({ max_results: 30, sort: "submitted" }),
  }),
  "list-issues": hostCapability(listIssuesTool, {
    clampedProperties: ["limit"],
    defaultArgs: () => ({ state: "open", limit: 10 }),
  }),
  "read-issue": hostCapability(readIssueTool),
  "list-issue-comments": hostCapability(listIssueCommentsTool),
  "read-pull-request": hostCapability(readPullRequestTool),
  "list-pull-request-comments": hostCapability(listPullRequestCommentsTool),
  "comment-issue": hostCapability(commentIssueTool),
  "list-emails": hostCapability(listEmailsTool, {
    clampedProperties: ["limit"],
    defaultArgs: () => ({ limit: 10, folder: "inbox", unreadOnly: false }),
  }),
  "read-email": hostCapability(readEmailTool, {
    defaultArgs: () => ({ markAsRead: true }),
  }),
  "list-calendars": hostCapability(listCalendarsTool),
  "list-events": hostCapability(listEventsTool, {
    clampedProperties: ["maxResults"],
    defaultArgs: () => ({
      timeMin: new Date().toISOString(),
      maxResults: 10,
      calendarId: "primary",
    }),
  }),
  "read-event": hostCapability(readEventTool, {
    defaultArgs: () => ({ calendarId: "primary" }),
  }),
  "create-event": hostCapability(createEventTool, {
    defaultArgs: () => ({ calendarId: "primary" }),
  }),
  "update-event": hostCapability(updateEventTool, {
    defaultArgs: () => ({ calendarId: "primary" }),
  }),
  "delete-event": hostCapability(deleteEventTool, {
    defaultArgs: () => ({ calendarId: "primary" }),
  }),
  "agent-reach": hostCapability(agentReachCapabilityTool),
} satisfies Record<string, CapabilityDefinition>;

type ToolName = keyof typeof TOOL_FACTORIES;

export type {
  AgentToolFactory,
  CapabilityDispatchContext,
} from "./capability.js";

export function getCapabilityDefinition(
  name: string,
): CapabilityDefinition | undefined {
  return CAPABILITIES[name as keyof typeof CAPABILITIES];
}

export function hostCapabilityNames(toolNames: string[]): string[] {
  return toolNames.filter((name) => {
    const capability = getCapabilityDefinition(name);
    return capability?.executor === "host";
  });
}

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
  capabilityContext: CapabilityDispatchContext = {},
): AgentTool[] {
  const staticTools: AgentTool[] = [];

  for (const name of toolNames) {
    const capability = getCapabilityDefinition(name);
    if (capability) {
      const tool = dispatchCapability(capability, capabilityContext);
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
