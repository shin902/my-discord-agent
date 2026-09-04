import type { AgentTool } from "@earendil-works/pi-agent-core";
import { agentReachTool } from "./agent-reach.js";
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
  type CapabilityApprovalPolicy,
  type CapabilityArgsValidator,
  type CapabilityDefinition,
  type CapabilityDispatchContext,
  dispatchCapability,
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
  "agent-reach": createStaticToolFactory(agentReachTool),
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

function hostCapability(
  tool: AgentTool,
  clampedMaximumProperties: readonly string[] = [],
  approval?: CapabilityApprovalPolicy,
): CapabilityDefinition {
  return {
    tool: tool.name,
    executor: "host",
    factory: () => tool,
    validateArgs: validateToolArgs(tool, clampedMaximumProperties),
    ...(approval ? { approval } : {}),
  };
}

function approvalRequired(
  tool: AgentTool,
  target: (args: Record<string, unknown>) => string,
  summary: (args: Record<string, unknown>) => string,
  defaults: Record<string, unknown> = {},
): CapabilityApprovalPolicy {
  const properties = Object.keys(
    (tool.parameters as { properties?: Record<string, unknown> }).properties ??
      {},
  );
  const normalizeArgs = (value: unknown): Record<string, unknown> => {
    const args = isObjectArgs(value) ? value : {};
    const normalized: Record<string, unknown> = {};
    for (const property of properties) {
      if (Object.hasOwn(args, property)) normalized[property] = args[property];
      else if (Object.hasOwn(defaults, property))
        normalized[property] = defaults[property];
    }
    return normalized;
  };
  return {
    normalizeArgs,
    target: (args) => target(normalizeArgs(args)),
    summary: (args) => summary(normalizeArgs(args)),
  };
}

const CAPABILITIES = {
  date: {
    tool: "date",
    executor: "sandbox",
    factory: createStaticToolFactory(dateTool),
  },
  "get-current-weather": {
    tool: "get-current-weather",
    executor: "host",
    factory: () => getCurrentWeatherTool,
    validateArgs: currentWeatherArgsValidator,
  },
  "get-weather-forecast": {
    tool: "get-weather-forecast",
    executor: "host",
    factory: () => getWeatherForecastTool,
    validateArgs: weatherForecastArgsValidator,
  },
  "tavily-search": {
    tool: "tavily-search",
    executor: "host",
    // Host results cross the Tool Proxy as raw data; the sandbox-side thin
    // proxy applies the common output boundary after receiving them.
    factory: () => tavilySearchTool,
    validateArgs: tavilySearchArgsValidator,
  },
  "arxiv-search": hostCapability(arxivSearchTool, ["max_results"]),
  "arxiv-survey": hostCapability(arxivSurveyTool, ["max_results"]),
  "list-issues": hostCapability(listIssuesTool, ["limit"]),
  "read-issue": hostCapability(readIssueTool),
  "list-issue-comments": hostCapability(listIssueCommentsTool),
  "read-pull-request": hostCapability(readPullRequestTool),
  "list-pull-request-comments": hostCapability(listPullRequestCommentsTool),
  "comment-issue": hostCapability(
    commentIssueTool,
    [],
    approvalRequired(
      commentIssueTool,
      (args) =>
        `github:${String(args.owner).toLowerCase()}/${String(args.repo).toLowerCase()}#${String(args.issue_number)}`,
      (args) => `Comment: ${String(args.body)}`,
    ),
  ),
  "list-emails": hostCapability(listEmailsTool, ["limit"]),
  "read-email": hostCapability(readEmailTool),
  "list-calendars": hostCapability(listCalendarsTool),
  "list-events": hostCapability(listEventsTool, ["maxResults"]),
  "read-event": hostCapability(readEventTool),
  "create-event": hostCapability(
    createEventTool,
    [],
    approvalRequired(
      createEventTool,
      (args) => `google-calendar:${String(args.calendarId)}:new-event`,
      (args) =>
        `Create event "${String(args.summary)}" (${String(args.start)} – ${String(args.end)})`,
      { calendarId: "primary" },
    ),
  ),
  "update-event": hostCapability(
    updateEventTool,
    [],
    approvalRequired(
      updateEventTool,
      (args) =>
        `google-calendar:${String(args.calendarId)}:${String(args.eventId)}`,
      (args) => `Update event ${String(args.eventId)}`,
      { calendarId: "primary" },
    ),
  ),
  "delete-event": hostCapability(
    deleteEventTool,
    [],
    approvalRequired(
      deleteEventTool,
      (args) =>
        `google-calendar:${String(args.calendarId)}:${String(args.eventId)}`,
      (args) => `Delete event ${String(args.eventId)}`,
      { calendarId: "primary" },
    ),
  ),
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
