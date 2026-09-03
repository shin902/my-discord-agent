import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";

import { agentReachTool } from "./agent-reach.js";
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
  type RuntimeToolFactories,
  resolveTools,
} from "./registry.js";
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
    });

    await expect(tool?.execute("call-1", {})).rejects.toThrow(
      "Tool Proxy endpoint is unavailable",
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

  it("agent-reach を解決して agentReachTool を返す", () => {
    expect(resolveTools(["agent-reach"])).toEqual([agentReachTool]);
  });

  it("arxiv-search / arxiv-survey を解決する", () => {
    expect(resolveTools(["arxiv-search", "arxiv-survey"])).toEqual([
      arxivSearchTool,
      arxivSurveyTool,
    ]);
  });

  it("list-calendars を解決して listCalendarsTool を返す", () => {
    expect(resolveTools(["list-calendars"])).toEqual([listCalendarsTool]);
  });

  it("list-issue-comments を解決して listIssueCommentsTool を返す", () => {
    expect(resolveTools(["list-issue-comments"])).toEqual([
      listIssueCommentsTool,
    ]);
  });

  it("read-pull-request を解決して readPullRequestTool を返す", () => {
    expect(resolveTools(["read-pull-request"])).toEqual([readPullRequestTool]);
  });

  it("list-pull-request-comments を解決して listPullRequestCommentsTool を返す", () => {
    expect(resolveTools(["list-pull-request-comments"])).toEqual([
      listPullRequestCommentsTool,
    ]);
  });

  it("runtime factoryがないcontext-created toolは生成しない", () => {
    expect(resolveTools(["bot", "subagent"])).toEqual([]);
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
