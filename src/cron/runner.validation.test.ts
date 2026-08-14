import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./runner.js";

// --- loadAndValidateCron ---

describe("loadAndValidateCron", () => {
  let loadAndValidateCron: () => Promise<CronJob[]>;
  let NonRetryableError: typeof import("../utils/error.js").NonRetryableError;
  let mockReadFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockReadFile = vi.fn();

    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: vi.fn() }));
    vi.doMock("node:fs/promises", () => ({
      readFile: mockReadFile,
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));
    const discordClient = { isReady: vi.fn(), channels: { fetch: vi.fn() } };
    vi.doMock("../discord/client.js", () => ({
      getDefaultDiscordClient: () => discordClient,
      getDiscordClientForGroupName: vi.fn().mockResolvedValue(discordClient),
      getDiscordClients: () => new Map([["personal", discordClient]]),
    }));
    vi.doMock("../queue/repository.js", () => ({
      getQueueRepository: () => ({ enqueue: vi.fn() }),
    }));

    const runner = await import("./runner.js");
    loadAndValidateCron = runner.loadAndValidateCron;

    // Import NonRetryableError from the same module context as runner.js
    const errorMod = await import("../utils/error.js");
    NonRetryableError = errorMod.NonRetryableError;
  });

  afterEach(() => {
    vi.resetModules();
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

    await expect(loadAndValidateCron()).rejects.toThrow();
  });

  it("スキーマ検証失敗（handler なし時に必須フィールド不足）でエラーになる", async () => {
    const cronJson = JSON.stringify([
      {
        id: "missing-fields",
        schedule: "* * * * *",
        // groupName, prompt, channelId, deliveryMode, sessionMode がすべて不足
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

  it("存在しないハンドラーパスでエラーになる", async () => {
    const cronJson = JSON.stringify([
      {
        id: "bad-handler",
        schedule: "* * * * *",
        handler: "jobs/nonexistent.ts",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    await expect(loadAndValidateCron()).rejects.toThrow();
  });

  it(".. を含むパスで NonRetryableError を投げる", async () => {
    const cronJson = JSON.stringify([
      {
        id: "traversal",
        schedule: "* * * * *",
        handler: "../evil.ts",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    await expect(loadAndValidateCron()).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("プロジェクト外を参照する絶対パスで NonRetryableError を投げる", async () => {
    const cronJson = JSON.stringify([
      {
        id: "outside",
        schedule: "* * * * *",
        handler: "/etc/passwd.ts",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    await expect(loadAndValidateCron()).rejects.toBeInstanceOf(
      NonRetryableError,
    );
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
        sessionMode: "per-run",
      },
    ]);
    mockReadFile.mockResolvedValueOnce(cronJson);

    const result = await loadAndValidateCron();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("group-job");
  });

  it("deliveryMode/sessionMode の片方だけではエラーになる", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "missing-session-mode",
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

  it("handler付きジョブでもdeliveryMode/sessionModeの片方だけではエラーになる", async () => {
    mockReadFile.mockResolvedValueOnce(
      JSON.stringify([
        {
          id: "handler-missing-session-mode",
          schedule: "5m",
          handler: "jobs/rss-dispatch.ts",
          deliveryMode: "new-thread",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow(
      "deliveryMode と sessionMode は両方指定してください",
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
          sessionMode: "per-run",
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
          sessionMode: "destination",
        },
      ]),
    );

    await expect(loadAndValidateCron()).rejects.toThrow(
      "mode と deliveryMode/sessionMode は同時に指定できません",
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

describe("loadHandlerFn — resolveHandlerPath", () => {
  let loadHandlerFn: (path: string) => Promise<unknown>;
  let NonRetryableError: typeof import("../utils/error.js").NonRetryableError;

  beforeEach(async () => {
    vi.resetModules();
    const discordClient = { isReady: vi.fn(), channels: { fetch: vi.fn() } };
    vi.doMock("../discord/client.js", () => ({
      getDefaultDiscordClient: () => discordClient,
      getDiscordClientForGroupName: vi.fn().mockResolvedValue(discordClient),
      getDiscordClients: () => new Map([["personal", discordClient]]),
    }));
    vi.doMock("../queue/repository.js", () => ({
      getQueueRepository: () => ({ enqueue: vi.fn() }),
    }));

    const runner = await import("./runner.js");
    loadHandlerFn = runner.loadHandlerFn;

    const errorMod = await import("../utils/error.js");
    NonRetryableError = errorMod.NonRetryableError;
  });

  afterEach(() => {
    vi.resetModules();
  });

  it(".. を含むパスで NonRetryableError を投げる", async () => {
    await expect(loadHandlerFn("../evil.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("..\\ を含むパス（Windows スタイル）で NonRetryableError を投げる", async () => {
    await expect(loadHandlerFn("..\\evil.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("パス中に ../ が埋め込まれている場合 NonRetryableError を投げる", async () => {
    await expect(loadHandlerFn("jobs/../../evil.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("プロジェクト外を参照する絶対パスで NonRetryableError を投げる", async () => {
    await expect(loadHandlerFn("/etc/passwd.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("有効なハンドラーは正常に読み込める", async () => {
    const fn = await loadHandlerFn("__fixtures__/test-handler.ts");
    expect(typeof fn).toBe("function");
  });
});
