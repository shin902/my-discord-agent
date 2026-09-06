import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { arxivSearchTool } from "./arxiv.js";
import { dispatchCapability, materializeCapabilityArgs } from "./capability.js";
import { wrapToolOutput } from "./output.js";
import {
  type AgentToolFactory,
  getCapabilityDefinition,
  type RuntimeToolFactories,
  resolveTools,
} from "./registry.js";

afterEach(() => vi.unstubAllGlobals());

describe("resolveTools", () => {
  it("sandbox / host toolを指定順に解決し、重複を維持する", () => {
    expect(
      resolveTools(["read", "date", "grep"]).map((tool) => tool.name),
    ).toEqual(["read", "date", "grep"]);
    expect(resolveTools(["date", "date"]).map((tool) => tool.name)).toEqual([
      "date",
      "date",
    ]);
    expect(
      resolveTools([
        "get-weather-forecast",
        "date",
        "get-current-weather",
        "arxiv-survey",
        "arxiv-search",
      ]).map((tool) => tool.name),
    ).toEqual([
      "get-weather-forecast",
      "date",
      "get-current-weather",
      "arxiv-survey",
      "arxiv-search",
    ]);
  });

  it("date は現在時刻をAgent-facing形式で返す", async () => {
    const [tool] = resolveTools(["date"]);

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

  it("materializer未指定のhost capabilityはargs identityを維持する", () => {
    const args = { value: "unchanged" };
    const definition = {
      tool: "host-test",
      executor: "host" as const,
      factory: () => undefined,
      validateArgs: () => true,
    };

    expect(materializeCapabilityArgs(definition, args)).toBe(args);
  });

  it("host capability argsのdefault/clamp/未知property除去を一度に実効化する", () => {
    const capability = getCapabilityDefinition("get-weather-forecast");
    expect(capability?.executor).toBe("host");
    if (!capability || capability.executor !== "host") return;
    const rawArgs = { location: "東京", days: 10, ignored: "raw-only" };

    expect(materializeCapabilityArgs(capability, rawArgs)).toEqual({
      location: "東京",
      days: 7,
    });
    expect(rawArgs).toEqual({
      location: "東京",
      days: 10,
      ignored: "raw-only",
    });
    expect(materializeCapabilityArgs(capability, { location: "東京" })).toEqual(
      { location: "東京", days: 3 },
    );
  });

  it.each([
    [
      "tavily-search",
      { query: "q" },
      {
        query: "q",
        max_results: 5,
        search_depth: "basic",
        include_answer: true,
        topic: "general",
      },
    ],
    [
      "arxiv-search",
      { query: "q" },
      { query: "q", max_results: 10, sort: "relevance" },
    ],
    [
      "arxiv-survey",
      { queries: ["q"] },
      { queries: ["q"], max_results: 30, sort: "submitted" },
    ],
    [
      "list-issues",
      { owner: "o", repo: "r" },
      { owner: "o", repo: "r", state: "open", limit: 10 },
    ],
    ["list-emails", {}, { limit: 10, folder: "inbox", unreadOnly: false }],
    ["read-email", { id: "m" }, { id: "m", markAsRead: true }],
    ["read-event", { eventId: "e" }, { eventId: "e", calendarId: "primary" }],
    [
      "create-event",
      { summary: "s", start: "2026-09-05", end: "2026-09-06" },
      {
        summary: "s",
        start: "2026-09-05",
        end: "2026-09-06",
        calendarId: "primary",
      },
    ],
    [
      "update-event",
      { eventId: "e", summary: "s" },
      { eventId: "e", summary: "s", calendarId: "primary" },
    ],
    ["delete-event", { eventId: "e" }, { eventId: "e", calendarId: "primary" }],
  ])("%s は既存executorのdefaultをapproval前に実効化する", (name, raw, expected) => {
    const capability = getCapabilityDefinition(name);
    expect(capability?.executor).toBe("host");
    if (!capability || capability.executor !== "host") return;

    expect(materializeCapabilityArgs(capability, raw)).toEqual(expected);
  });

  it("動的defaultはmaterialize時に固定する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-05T01:02:03.456Z"));
    try {
      const capability = getCapabilityDefinition("list-events");
      expect(capability?.executor).toBe("host");
      if (!capability || capability.executor !== "host") return;

      expect(materializeCapabilityArgs(capability, {})).toEqual({
        timeMin: "2026-09-05T01:02:03.456Z",
        maxResults: 10,
        calendarId: "primary",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("registry is the source of host weather capability definitions", () => {
    expect(getCapabilityDefinition("get-current-weather")).toMatchObject({
      tool: "get-current-weather",
      executor: "host",
      factory: expect.any(Function),
      validateArgs: expect.any(Function),
      materializeArgs: expect.any(Function),
    });
    expect(getCapabilityDefinition("get-weather-forecast")).toMatchObject({
      tool: "get-weather-forecast",
      executor: "host",
      factory: expect.any(Function),
      validateArgs: expect.any(Function),
      materializeArgs: expect.any(Function),
    });
    expect(getCapabilityDefinition("tavily-search")).toMatchObject({
      tool: "tavily-search",
      executor: "host",
      factory: expect.any(Function),
      validateArgs: expect.any(Function),
      materializeArgs: expect.any(Function),
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
      materializeArgs: expect.any(Function),
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

  it.each([
    { name: "get-current-weather", args: { location: "東京" } },
    { name: "get-weather-forecast", args: { location: "東京", days: 3 } },
    { name: "tavily-search", args: { query: "test" } },
    { name: "agent-reach", args: { url: "https://example.com" } },
    { name: "arxiv-search", args: { query: "test" } },
    { name: "arxiv-survey", args: { queries: ["test"] } },
    { name: "list-calendars", args: {} },
    {
      name: "list-issue-comments",
      args: { owner: "o", repo: "r", issue_number: 1 },
    },
    {
      name: "read-pull-request",
      args: { owner: "o", repo: "r", pull_number: 1 },
    },
    {
      name: "list-pull-request-comments",
      args: { owner: "o", repo: "r", pull_number: 1 },
    },
  ])("$name はローカル実行せず指定したTool Proxyへ委譲する", async ({
    name,
    args,
  }) => {
    const response = {
      content: [{ type: "text" as const, text: "host response" }],
      details: { source: "host" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ result: response })));
    vi.stubGlobal("fetch", fetchMock);
    const [tool] = resolveTools(
      [name],
      {},
      { toolProxyEndpoint: { url: "http://proxy/rpc", token: "run-token" } },
    );

    expect(tool.name).toBe(name);
    expect(await tool.execute("call-1", args)).toEqual(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("http://proxy/rpc");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer run-token",
      },
    });
    expect(JSON.parse(request.body)).toEqual({ capability: name, args });
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

    const wrapped = wrapToolOutput(tool);
    const wrappedAgain = wrapToolOutput(wrapped);
    await wrappedAgain.execute("call-1", {});

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
