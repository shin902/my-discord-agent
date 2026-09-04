import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

import { agentReachCapabilityTool } from "./agent-reach-capability.js";
import { arxivSearchTool, arxivSurveyTool } from "./arxiv.js";
import { listCalendarsTool } from "./calendar.js";
import { dispatchCapability } from "./capability.js";
import { dateTool } from "./date.js";
import {
  listIssueCommentsTool,
  listPullRequestCommentsTool,
  readPullRequestTool,
} from "./github.js";
import { wrapToolOutput } from "./output.js";
import {
  type AgentToolFactory,
  getCapabilityDefinition,
  type RuntimeToolFactories,
  resolveTools,
} from "./registry.js";
import { tavilySearchTool } from "./tavily.js";
import { getCurrentWeatherTool, getWeatherForecastTool } from "./weather.js";

describe("resolveTools", () => {
  it("静的toolを指定順に解決する", () => {
    expect(
      resolveTools(["read", "date", "grep"]).map((tool) => tool.name),
    ).toEqual(["read", "date", "grep"]);
    expect(resolveTools(["date", "date"]).map((tool) => tool.name)).toEqual([
      "date",
      "date",
    ]);
  });

  it("date は sandbox capability dispatcher 経由で既存toolを返す", async () => {
    const [tool] = resolveTools(["date"]);

    expect(tool).toBe(dateTool);
    expect(tool).toMatchObject({
      name: dateTool.name,
      label: dateTool.label,
      description: dateTool.description,
      parameters: dateTool.parameters,
    });

    const result = await tool.execute("call-1", {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Current time:"),
    });
    expect(result.details).toMatchObject({
      timestamp: expect.any(Number),
      localDateTime: expect.any(String),
      timezone: expect.any(String),
      timezoneLabel: expect.any(String),
      utcOffset: expect.any(String),
      utc: expect.any(String),
    });
  });

  it("sandbox capability は trusted factory を実行する", () => {
    const tool = {
      name: "sandbox-test",
      label: "sandbox-test",
      description: "sandbox-test",
      parameters: {} as never,
      execute: vi.fn(),
    } satisfies AgentTool;
    const factory = vi.fn(() => tool);

    expect(
      dispatchCapability({
        tool: "sandbox-test",
        executor: "sandbox",
        factory,
      }),
    ).toBe(tool);
    expect(factory).toHaveBeenCalledOnce();
  });

  it("host capability は thin proxy を返し endpoint 未指定時は fail closed する", async () => {
    const tool = dispatchCapability({
      tool: "host-test",
      executor: "host",
      factory: vi.fn(() => ({
        name: "host-test",
        label: "host-test",
        description: "host-test",
        parameters: {} as never,
        execute: vi.fn(),
      })),
      validateArgs: () => true,
    });

    await expect(tool?.execute("call-1", {})).rejects.toThrow(
      "Tool Proxy endpoint is unavailable",
    );
  });

  it("registry is the source of host weather capability definitions", () => {
    expect(getCapabilityDefinition("get-current-weather")).toMatchObject({
      tool: "get-current-weather",
      executor: "host",
      factory: expect.any(Function),
      validateArgs: expect.any(Function),
    });
    expect(getCapabilityDefinition("get-weather-forecast")).toMatchObject({
      tool: "get-weather-forecast",
      executor: "host",
      factory: expect.any(Function),
      validateArgs: expect.any(Function),
    });
    expect(getCapabilityDefinition("tavily-search")).toMatchObject({
      tool: "tavily-search",
      executor: "host",
      factory: expect.any(Function),
      validateArgs: expect.any(Function),
    });
    expect(getCapabilityDefinition("does-not-exist")).toBeUndefined();
  });

  it.each([
    "arxiv-search",
    "arxiv-survey",
    "list-issues",
    "read-issue",
    "list-issue-comments",
    "read-pull-request",
    "list-pull-request-comments",
    "comment-issue",
    "list-emails",
    "read-email",
    "list-calendars",
    "list-events",
    "read-event",
    "create-event",
    "update-event",
    "delete-event",
  ])("%s はhost capabilityである", (name) => {
    expect(getCapabilityDefinition(name)).toMatchObject({
      tool: name,
      executor: "host",
      factory: expect.any(Function),
      validateArgs: expect.any(Function),
    });
  });

  it("host proxyは既存Agent-facing contractを維持する", () => {
    const [tool] = resolveTools(["arxiv-search"]);
    expect(tool).toMatchObject({
      name: arxivSearchTool.name,
      label: arxivSearchTool.label,
      description: arxivSearchTool.description,
      parameters: arxivSearchTool.parameters,
    });
  });

  it("schema由来のvalidationは型を検証し、executorのclampを妨げない", () => {
    const capability = getCapabilityDefinition("list-issues");
    expect(capability?.executor).toBe("host");
    if (!capability || capability.executor !== "host") return;
    expect(capability.validateArgs({ owner: "o", repo: "r", limit: 99 })).toBe(
      true,
    );
    expect(
      capability.validateArgs({ owner: "o", repo: "r", limit: "10" }),
    ).toBe(false);
    expect(capability.validateArgs({ owner: "o", repo: "r", limit: 0 })).toBe(
      false,
    );
  });

  it("executorが正規化しないschema制約はhost境界で維持する", () => {
    const capability = getCapabilityDefinition("arxiv-survey");
    expect(capability?.executor).toBe("host");
    if (!capability || capability.executor !== "host") return;
    expect(
      capability.validateArgs({
        queries: Array.from({ length: 9 }, () => "q"),
      }),
    ).toBe(false);
    expect(capability.validateArgs({ queries: ["x".repeat(501)] })).toBe(false);
    expect(capability.validateArgs({ queries: ["q"], max_results: 99 })).toBe(
      true,
    );
  });

  it("weather capability routes through the host executor contract", () => {
    const tools = resolveTools(
      ["get-current-weather", "get-weather-forecast"],
      {},
      { toolProxyEndpoint: { url: "http://proxy/rpc", token: "token" } },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "get-current-weather",
      "get-weather-forecast",
    ]);
    expect(tools[0]).not.toBe(getCurrentWeatherTool);
    expect(tools[1]).not.toBe(getWeatherForecastTool);
  });

  it("tavily-search routes through the host executor contract", () => {
    const [tool] = resolveTools(
      ["tavily-search"],
      {},
      { toolProxyEndpoint: { url: "http://proxy/rpc", token: "token" } },
    );

    expect(tool?.name).toBe("tavily-search");
    expect(tool).not.toBe(tavilySearchTool);
  });

  it("agent-reach をhost capabilityとして解決する", () => {
    const [tool] = resolveTools(
      ["agent-reach"],
      {},
      {
        toolProxyEndpoint: { url: "http://proxy/rpc", token: "token" },
      },
    );
    expect(tool?.name).toBe(agentReachCapabilityTool.name);
    expect(tool).not.toBe(agentReachCapabilityTool);
    expect(getCapabilityDefinition("agent-reach")?.executor).toBe("host");
  });

  it("arxiv-search / arxiv-survey をhost proxyとして解決する", () => {
    const tools = resolveTools(["arxiv-search", "arxiv-survey"]);
    expect(tools.map((tool) => tool.name)).toEqual([
      arxivSearchTool.name,
      arxivSurveyTool.name,
    ]);
    expect(tools[0]).not.toBe(arxivSearchTool);
    expect(tools[1]).not.toBe(arxivSurveyTool);
  });

  it("list-calendars をhost proxyとして解決する", () => {
    const [tool] = resolveTools(["list-calendars"]);
    expect(tool?.name).toBe(listCalendarsTool.name);
    expect(tool).not.toBe(listCalendarsTool);
  });

  it("list-issue-comments を解決して listIssueCommentsTool を返す", () => {
    const [tool] = resolveTools(["list-issue-comments"]);
    expect(tool?.name).toBe(listIssueCommentsTool.name);
    expect(tool).not.toBe(listIssueCommentsTool);
  });

  it("read-pull-request を解決して readPullRequestTool を返す", () => {
    const [tool] = resolveTools(["read-pull-request"]);
    expect(tool?.name).toBe(readPullRequestTool.name);
    expect(tool).not.toBe(readPullRequestTool);
  });

  it("list-pull-request-comments を解決して listPullRequestCommentsTool を返す", () => {
    const [tool] = resolveTools(["list-pull-request-comments"]);
    expect(tool?.name).toBe(listPullRequestCommentsTool.name);
    expect(tool).not.toBe(listPullRequestCommentsTool);
  });

  it("runtime factoryがないcontext-created toolは生成しない", () => {
    expect(resolveTools(["bot", "subagent"])).toEqual([]);
  });

  it.each([
    "tavily-extract",
    "tavily-crawl",
    "tavily-map",
    "browserless-smart-scrape",
    "browserless-search",
    "browserless-function",
    "browserless-content",
    "clone-repository",
  ])("削除済みtool %s を解決しない", (name) => {
    expect(() => resolveTools([name])).toThrow(`不明なツール名: ${name}`);
  });

  it("runtime factoryをstatic toolと同じ解決経路で使う", () => {
    const createTestTool =
      (name: string): AgentToolFactory =>
      () => ({
        name,
        label: name,
        description: name,
        parameters: {} as never,
        execute: vi.fn(),
      });
    const botFactory = createTestTool("bot");
    const subagentFactory = createTestTool("subagent");
    const runtimeFactories = {
      bot: botFactory,
      subagent: subagentFactory,
    } satisfies RuntimeToolFactories;
    // @ts-expect-error Static tool factories are not runtime overrides.
    const invalidRuntimeFactories: RuntimeToolFactories = { read: botFactory };
    void invalidRuntimeFactories;

    const tools = resolveTools(["subagent", "read", "bot"], runtimeFactories);

    expect(tools.map((tool) => tool.name)).toEqual(["read", "subagent", "bot"]);
  });

  it("legacy order and duplicate behavior are preserved", () => {
    const createTestTool =
      (name: string): AgentToolFactory =>
      () => ({
        name,
        label: name,
        description: name,
        parameters: {} as never,
        execute: vi.fn(),
      });
    const botFactory = vi.fn(createTestTool("bot"));
    const subagentFactory = vi.fn(createTestTool("subagent"));

    const tools = resolveTools(
      ["bot", "read", "subagent", "read", "bot", "subagent"],
      { bot: botFactory, subagent: subagentFactory },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "read",
      "subagent",
      "bot",
    ]);
    expect(subagentFactory).toHaveBeenCalledOnce();
    expect(botFactory).toHaveBeenCalledOnce();
  });

  it("空配列は空配列を返す", () => {
    expect(resolveTools([])).toEqual([]);
  });

  it("不明なツール名はエラーをスローする", () => {
    expect(() => resolveTools(["invalid"])).toThrow("不明なツール名: invalid");
  });

  it("production registry tools receive the common output boundary", async () => {
    const directory = await mkdtemp("/tmp/registry-output-");
    const path = join(directory, "input.txt");
    const text = "registry-line\n".repeat(5_000);
    await writeFile(path, text, "utf8");

    try {
      const [tool] = resolveTools(["read"]);
      const result = await tool.execute("call-1", { path });

      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("ツール出力が大きいため"),
      });
      expect(result.details).toMatchObject({
        truncated: true,
        fullOutputPath: expect.stringMatching(/^\/tmp\/my-discord-agent-tool-/),
        truncation: {
          reason: "text-output-too-large",
          totalCharacters: text.length,
          totalBytes: Buffer.byteLength(text, "utf8"),
          totalLines: 5_000,
          inlineCharacterLimit: 50_000,
          lifetime: "container-run",
        },
      });
      const fullOutputPath = (result.details as { fullOutputPath: string })
        .fullOutputPath;
      expect(await readFile(fullOutputPath, "utf8")).toBe(text);
      await rm(dirname(fullOutputPath), { recursive: true, force: true });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not multi-wrap singleton tools", () => {
    const [first] = resolveTools(["read"]);
    const [second] = resolveTools(["read"]);
    const [duplicateFirst, duplicateSecond] = resolveTools(["read", "read"]);

    expect(second).toBe(first);
    expect(duplicateFirst).toBe(first);
    expect(duplicateSecond).toBe(first);
  });

  it("wrapToolOutput is idempotent for a singleton and invokes its execute once", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "small output" }],
      details: { source: "test" },
    }));
    const tool: AgentTool = {
      name: "singleton-test",
      label: "singleton-test",
      description: "singleton-test",
      parameters: {} as never,
      execute,
    };

    expect(wrapToolOutput(tool)).toBe(tool);
    expect(wrapToolOutput(tool)).toBe(tool);
    await tool.execute("call-1", {});

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
