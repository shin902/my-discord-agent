import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./runner.js";

// --- loadAndValidateCron ---

describe("loadAndValidateCron", () => {
  let loadAndValidateCron: () => Promise<CronJob[]>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let findGroupByNameMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockReadFile = vi.fn();

    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn() }));
    vi.doMock("node:fs/promises", () => ({
      readFile: mockReadFile,
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../config/groups.js", async () => {
      const actual = await vi.importActual<
        typeof import("../config/groups.js")
      >("../config/groups.js");
      findGroupByNameMock = vi.fn().mockResolvedValue(undefined);
      return { ...actual, findGroupByName: findGroupByNameMock };
    });
    const discordClient = { isReady: vi.fn(), channels: { fetch: vi.fn() } };
    vi.doMock("../discord/client.js", () => ({
      getDefaultDiscordClient: () => discordClient,
      getDiscordClientForGroupName: vi.fn().mockResolvedValue(discordClient),
      getDiscordClients: () => new Map([["personal", discordClient]]),
    }));
    vi.doMock("../queue/repository.js", () => ({
      getQueueRepository: () => ({ enqueue: vi.fn() }),
    }));

    vi.doMock("../config/bots.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../config/bots.js")>()),
      loadBotRegistry: vi.fn().mockResolvedValue({
        research: {
          group: "g",
          instructions: "role",
          tools: ["get-current-weather"],
        },
      }),
    }));
    const runner = await import("./runner.js");
    loadAndValidateCron = runner.loadAndValidateCron;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    { botId: "research", groupName: "g", valid: true },
    { botId: "missing", groupName: "g", valid: false },
    { botId: "research", groupName: "other", valid: false },
    { botId: "research", groupName: undefined, valid: false },
    { botId: "", groupName: "g", valid: false },
  ])("validates cron Bot membership: %j", async ({
    botId,
    groupName,
    valid,
  }) => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "bot-job",
          schedule: "5m",
          groupName,
          botId,
          prompt: "p",
          channelId: "c",
          deliveryMode: "direct",
          historyMode: "full",
          approvalRequiredTools: ["get-current-weather"],
        },
      ]),
    );
    if (valid) {
      await expect(loadAndValidateCron()).resolves.toEqual([
        expect.objectContaining({ botId: "research", groupName: "g" }),
      ]);
    } else {
      await expect(loadAndValidateCron()).rejects.toThrow();
    }
  });

  it.each([
    { id: " \t\n", valid: false },
    { id: " daily report / v2 ", valid: true },
  ])("validates nonblank cron IDs without normalizing them: %j", async ({
    id,
    valid,
  }) => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id,
          schedule: "5m",
          groupName: "g",
          prompt: "p",
          channelId: "c",
          deliveryMode: "direct",
          historyMode: "fresh",
        },
      ]),
    );
    if (valid) {
      await expect(loadAndValidateCron()).resolves.toEqual([
        expect.objectContaining({ id }),
      ]);
    } else {
      await expect(loadAndValidateCron()).rejects.toThrow(
        "cron job id must not be empty or whitespace-only",
      );
    }
  });

  it("スキーマ検証失敗（重複ID）でエラーになる", async () => {
    const cronJson = JSON.stringify([
      {
        id: "dup",
        schedule: "* * * * *",
        groupName: "g",
        prompt: "p",
        channelId: "c",
        mode: "to-channel",
      },
      {
        id: "dup",
        schedule: "5m",
        groupName: "g",
        prompt: "p",
        channelId: "c",
        mode: "to-channel",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    await expect(loadAndValidateCron()).rejects.toThrow(
      "ジョブIDが重複しています",
    );
  });

  it("スキーマ検証失敗（handler なし時に必須フィールド不足）でエラーになる", async () => {
    const cronJson = JSON.stringify([
      {
        id: "missing-fields",
        schedule: "* * * * *",
        // groupName, prompt, channelId, deliveryMode, historyMode がすべて不足
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    await expect(loadAndValidateCron()).rejects.toThrow();
  });

  it("ENOENT 時に空配列を返す", async () => {
    mockReadFile.mockRejectedValueOnce(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    const result = await loadAndValidateCron();
    expect(result).toEqual([]);
  });

  it("@startup + handler は拒否する", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "startup-handler",
          schedule: "@startup",
          handler: "__fixtures__/test-handler.ts",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow(
      "@startup は handler 付きジョブでは使用できません",
    );
  });

  it("有効なハンドラー付きジョブは検証に成功する", async () => {
    const cronJson = JSON.stringify([
      {
        id: "test-handler-job",
        schedule: "* * * * *",
        handler: "__fixtures__/test-handler.ts",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    const result = await loadAndValidateCron();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("test-handler-job");
  });

  it("rejects the obsolete periodic screen capture consumer", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "screen-capture-summary",
          schedule: "5m",
          enabled: true,
          handler: "jobs/screen-capture-summary.ts",
        },
      ]),
    );
    await expect(loadAndValidateCron()).rejects.toThrow(
      "screen-capture-summary cron is obsolete",
    );
  });

  it("propagates handler import failure during startup", async () => {
    const cronJson = JSON.stringify([
      {
        id: "bad-handler",
        schedule: "* * * * *",
        handler: "jobs/nonexistent.ts",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    await expect(loadAndValidateCron()).rejects.toThrow("nonexistent");
  });

  it("handler なしジョブ（グループモード）は検証に成功する", async () => {
    const cronJson = JSON.stringify([
      {
        id: "group-job",
        schedule: "5m",
        groupName: "my-group",
        prompt: "do something",
        channelId: "ch-123",
        deliveryMode: "direct",
        historyMode: "fresh",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    const result = await loadAndValidateCron();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("group-job");
  });

  it("enabled declarative jobのapprovalRequiredToolsを起動時に検証する", async () => {
    const cases = [
      {
        approvalRequiredTools: ["missing-tool"],
        tools: ["missing-tool"],
        message: "不明なツール名: missing-tool",
      },
      {
        approvalRequiredTools: ["read"],
        tools: ["read"],
        message:
          "承認必須ツールには host/runtime capability のみ指定できます: read",
      },
      {
        approvalRequiredTools: ["get-current-weather"],
        tools: ["read"],
        message:
          "承認必須ツールは有効な tools または toolSets に含めてください: get-current-weather",
      },
    ];

    for (const testCase of cases) {
      vi.resetModules();
      findGroupByNameMock.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValueOnce(
        JSON.stringify([
          {
            id: "invalid-approval",
            schedule: "5m",
            groupName: "my-group",
            prompt: "do something",
            channelId: "ch-123",
            deliveryMode: "direct",
            historyMode: "fresh",
            ...testCase,
          },
        ]),
      );
      const runner = await import("./runner.js");

      await expect(runner.loadAndValidateCron()).rejects.toThrow(
        testCase.message,
      );
    }
  });

  it("handler付きjobのapprovalRequiredToolsは自由なjob契約として検証しない", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "handler-approval-settings",
          schedule: "5m",
          handler: "__fixtures__/test-handler.ts",
          tools: ["read"],
          approvalRequiredTools: ["missing-tool"],
        },
      ]),
    );

    await expect(loadAndValidateCron()).resolves.toHaveLength(1);
  });

  it("cron jobのapprovalRequiredToolsはgroupから継承し、[]で解除する", async () => {
    findGroupByNameMock.mockResolvedValue({
      name: "my-group",
      tools: ["get-current-weather"],
      approvalRequiredTools: ["get-current-weather"],
      channels: [],
    });

    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "inherited-approval",
          schedule: "5m",
          groupName: "my-group",
          prompt: "do something",
          channelId: "ch-123",
          deliveryMode: "direct",
          historyMode: "fresh",
        },
      ]),
    );
    const inherited = await loadAndValidateCron();
    expect(inherited).toHaveLength(1);

    vi.resetModules();
    findGroupByNameMock.mockResolvedValue({
      name: "my-group",
      tools: ["get-current-weather"],
      approvalRequiredTools: ["get-current-weather"],
      channels: [],
    });
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "cleared-approval",
          schedule: "5m",
          groupName: "my-group",
          prompt: "do something",
          channelId: "ch-123",
          deliveryMode: "direct",
          historyMode: "fresh",
          tools: ["read"],
          approvalRequiredTools: [],
        },
      ]),
    );
    const cleared = await import("./runner.js");
    await expect(cleared.loadAndValidateCron()).resolves.toHaveLength(1);
  });

  it("cron jobでもAgentConfigのmounts overrideを受理する", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "mount-override",
          schedule: "5m",
          groupName: "my-group",
          prompt: "do something",
          channelId: "ch-123",
          deliveryMode: "direct",
          historyMode: "fresh",
          mounts: [{ host: "repo", container: "/repo", readOnly: true }],
        },
      ]),
    );

    const result = await loadAndValidateCron();
    expect(result[0].mounts).toEqual([
      { host: "repo", container: "/repo", readOnly: true },
    ]);
  });

  it("item-thread + full は検証に成功する", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "item-thread-job",
          schedule: "5m",
          groupName: "my-group",
          prompt: "summarize item",
          channelId: "ch-123",
          deliveryMode: "item-thread",
          historyMode: "full",
        },
      ]),
    );

    await expect(loadAndValidateCron()).resolves.toHaveLength(1);
  });

  it.each([
    {
      id: "declarative",
      groupName: "my-group",
      prompt: "summarize item",
      channelId: "ch-123",
    },
    { id: "handler", handler: "__fixtures__/test-handler.ts" },
  ])("$id item-thread で noReply を受理する", async (job) => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          ...job,
          schedule: "5m",
          deliveryMode: "item-thread",
          historyMode: "full",
          noReply: true,
        },
      ]),
    );

    await expect(loadAndValidateCron()).resolves.toHaveLength(1);
  });

  it("item-thread は fresh historyModeを拒否する", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "invalid-item-thread",
          schedule: "5m",
          groupName: "my-group",
          prompt: "summarize item",
          channelId: "ch-123",
          deliveryMode: "item-thread",
          historyMode: "fresh",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow(
      "item-thread は historyMode=full または final-only と組み合わせてください",
    );
  });

  it("deliveryMode/historyMode の片方だけではエラーになる", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "missing-history-mode",
          schedule: "5m",
          groupName: "my-group",
          prompt: "do something",
          channelId: "ch-123",
          deliveryMode: "direct",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow();
  });

  it("handler付きジョブでもdeliveryMode/historyModeの片方だけではエラーになる", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "handler-missing-history-mode",
          schedule: "5m",
          handler: "jobs/rss-dispatch.ts",
          deliveryMode: "new-thread",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow(
      "deliveryMode と historyMode は両方指定してください",
    );
  });

  it("旧 mode と新しいモードの混在はエラーになる", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "mixed-mode",
          schedule: "5m",
          groupName: "my-group",
          prompt: "do something",
          channelId: "ch-123",
          mode: "to-channel",
          deliveryMode: "direct",
          historyMode: "fresh",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow();
  });

  it("handler付きジョブでも旧modeと新しいモードの混在はエラーになる", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "handler-mixed-mode",
          schedule: "5m",
          handler: "jobs/rss-dispatch.ts",
          mode: "to-thread",
          deliveryMode: "new-thread",
          historyMode: "full",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow(
      "mode と deliveryMode/historyMode は同時に指定できません",
    );
  });

  it("後方互換として旧 mode も受理する", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "legacy-mode",
          schedule: "5m",
          groupName: "my-group",
          prompt: "do something",
          channelId: "ch-123",
          mode: "to-channel",
        },
      ]),
    );

    await expect(loadAndValidateCron()).resolves.toHaveLength(1);
  });

  it("settings フィールドは検証なしでそのまま通る", async () => {
    const cronJson = JSON.stringify([
      {
        id: "with-settings",
        schedule: "* * * * *",
        handler: "__fixtures__/test-handler.ts",
        settings: { maxResults: 10 },
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    const result = await loadAndValidateCron();
    expect(result).toHaveLength(1);
    expect(result[0].settings).toEqual({ maxResults: 10 });
  });

  it("空配列の cron.json は空配列を返す", async () => {
    mockReadFile.mockResolvedValueOnce("[]");

    const result = await loadAndValidateCron();
    expect(result).toEqual([]);
  });

  it("enabled: false の壊れたハンドラーは検証をスキップする", async () => {
    const cronJson = JSON.stringify([
      {
        id: "disabled-bad-handler",
        schedule: "* * * * *",
        enabled: false,
        handler: "jobs/nonexistent.ts",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    const result = await loadAndValidateCron();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("disabled-bad-handler");
  });
});

// --- loadHandlerFn (resolveHandlerPath 間接テスト) ---

describe("loadHandlerFn", () => {
  let loadHandlerFn: (path: string) => Promise<unknown>;
  let NonRetryableError: typeof import("../utils/error.js").NonRetryableError;

  beforeEach(async () => {
    vi.resetModules();
    ({ loadHandlerFn } = await import("./handler-loader.js"));

    const errorMod = await import("../utils/error.js");
    NonRetryableError = errorMod.NonRetryableError;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    "../evil.ts",
    "..\\evil.ts",
    "jobs/../../evil.ts",
    "/etc/passwd.ts",
  ])("rejects unsafe handler paths as non-retryable (%s)", async (handlerPath) => {
    await expect(loadHandlerFn(handlerPath)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("有効なハンドラーは正常に読み込める", async () => {
    const fn = await loadHandlerFn("__fixtures__/test-handler.ts");
    expect(typeof fn).toBe("function");
  });
});
