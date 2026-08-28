import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.resetModules() 後も同じ関数参照を保つためにホイスト
const mocks = vi.hoisted(() => ({
  initDiscordClients: vi.fn(),
  loginDiscordClients: vi.fn(),
  destroyDiscordClients: vi.fn(),
  discordClients: new Map([
    ["personal", { login: vi.fn(), isReady: vi.fn().mockReturnValue(true) }],
  ]),
  registerHandlers: vi.fn(),
  backfillDiscordMessages: vi.fn(),
  loadDiscordConfig: vi.fn(),
  loadBotRegistry: vi.fn(),
  startPoller: vi.fn(),
  stopPoller: vi.fn(),
  startDeliveryWorker: vi.fn(),
  stopDeliveryWorker: vi.fn(),
  loadGroups: vi.fn(),
  loadProviders: vi.fn(),
  initGroupPrompts: vi.fn(),
  initManager: vi.fn(),
  killAllRunningContainers: vi.fn(),
  validateGroupConfig: vi.fn(),
  validateBotConfigs: vi.fn(),
  loadDefaultModel: vi.fn(),
  loadAndValidateCron: vi.fn(),
  stopCron: vi.fn(),
  queueRepository: { db: {}, listRssStatePaths: vi.fn() },
  initializeQueue: vi.fn(),
  reconcileRssDispatches: vi.fn(),
  runRuntimeOperator: vi.fn(),
}));

vi.mock("./discord/client.js", () => ({
  initDiscordClients: mocks.initDiscordClients,
  loginDiscordClients: mocks.loginDiscordClients,
  destroyDiscordClients: mocks.destroyDiscordClients,
  getDiscordClients: () => mocks.discordClients,
}));
vi.mock("./discord/handler.js", () => ({
  registerHandlers: mocks.registerHandlers,
}));
vi.mock("./discord/backfill.js", () => ({
  backfillDiscordMessages: mocks.backfillDiscordMessages,
}));
vi.mock("./config/config.js", () => ({
  loadDiscordConfig: mocks.loadDiscordConfig,
}));
vi.mock("./config/bots.js", () => ({
  loadBotRegistry: mocks.loadBotRegistry,
  validateBotConfigs: mocks.validateBotConfigs,
}));
vi.mock("./queue/poller.js", () => ({
  startPoller: mocks.startPoller,
  stopPoller: mocks.stopPoller,
}));
vi.mock("./queue/delivery.js", () => ({
  startDeliveryWorker: mocks.startDeliveryWorker,
  stopDeliveryWorker: mocks.stopDeliveryWorker,
}));
vi.mock("./config/groups.js", () => ({ loadGroups: mocks.loadGroups }));
vi.mock("./config/providers.js", () => ({
  loadProviders: mocks.loadProviders,
}));
vi.mock("./config/group-config.js", () => ({
  ensureGroupDirs: vi.fn().mockResolvedValue(undefined),
  initGroupPrompts: mocks.initGroupPrompts,
}));
vi.mock("./agent/manager.js", () => ({
  initManager: mocks.initManager,
  killAllRunningContainers: mocks.killAllRunningContainers,
  validateGroupConfig: mocks.validateGroupConfig,
}));
vi.mock("./config/default-model.js", () => ({
  loadDefaultModel: mocks.loadDefaultModel,
}));
vi.mock("./proxy/credential-proxy-server.js", () => ({
  initCredentialProxyServer: vi.fn().mockResolvedValue(0),
  registerInternalRequestHandler: vi.fn(),
}));
vi.mock("./cron/runner.js", () => ({
  startCron: vi.fn(),
  stopCron: mocks.stopCron,
  loadAndValidateCron: mocks.loadAndValidateCron,
  _setCronJobs: vi.fn(),
}));
vi.mock("./queue/repository.js", () => ({
  getQueueRepository: () => mocks.queueRepository,
}));
vi.mock("./queue/migration.js", () => ({
  initializeQueue: mocks.initializeQueue,
}));
vi.mock("./queue/reconciliation.js", () => ({
  reconcileRssDispatches: mocks.reconcileRssDispatches,
}));
vi.mock("./queue/operator.js", () => ({
  runRuntimeOperator: mocks.runRuntimeOperator,
}));
vi.mock("dotenv/config", () => ({}));

describe("index: 起動時バリデーション", () => {
  const ORIGINAL_TOKEN = process.env.DISCORD_BOT_TOKEN;
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.DISCORD_BOT_TOKEN = "test-token";
    mocks.discordClients.clear();
    mocks.discordClients.set("personal", {
      login: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    });
    mocks.loadDiscordConfig.mockResolvedValue({ bots: {} });
    mocks.loadBotRegistry.mockResolvedValue({});
    mocks.backfillDiscordMessages.mockResolvedValue(undefined);
    mocks.loadGroups.mockResolvedValue([]);
    mocks.loadProviders.mockResolvedValue([]);
    mocks.initManager.mockResolvedValue(undefined);
    mocks.initGroupPrompts.mockResolvedValue(undefined);
    mocks.validateGroupConfig.mockResolvedValue(undefined);
    mocks.validateBotConfigs.mockResolvedValue(undefined);
    mocks.loadDefaultModel.mockResolvedValue({
      provider: "zai",
      modelId: "glm-4.7-flash",
    });
    mocks.loadAndValidateCron.mockResolvedValue([]);
    mocks.killAllRunningContainers.mockResolvedValue(undefined);
    mocks.queueRepository.listRssStatePaths.mockReturnValue([]);
    mocks.runRuntimeOperator.mockResolvedValue({
      health: { ok: true },
      observability: { alerts: [] },
    });
    // 実際に終了させず、呼び出し後の継続を防ぐためにスロー
    mockExit = vi.fn((code?: number) => {
      throw new Error(`process.exit(${code})`);
    });
    (process as unknown as { exit: typeof mockExit }).exit = mockExit;
  });

  afterEach(() => {
    mockExit.mockRestore();
    if (ORIGINAL_TOKEN === undefined) {
      delete process.env.DISCORD_BOT_TOKEN;
    } else {
      process.env.DISCORD_BOT_TOKEN = ORIGINAL_TOKEN;
    }
  });

  it("DISCORD_BOT_TOKEN 未設定は起動時にスロー", async () => {
    delete process.env.DISCORD_BOT_TOKEN;
    mocks.loadDiscordConfig.mockRejectedValue(
      new Error("DISCORD_BOT_TOKEN が設定されていません"),
    );
    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("不正な Bot profile は [startup] ログを出して process.exit(1) する", async () => {
    mocks.loadBotRegistry.mockRejectedValue(
      new Error("bots.coding.instructions は必須です"),
    );

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.initDiscordClients).not.toHaveBeenCalled();
  });

  it("不正な Bot の effective config は Discord 初期化前に停止する", async () => {
    mocks.loadGroups.mockResolvedValue([
      {
        name: "main",
        channels: [],
        model: { provider: "zai", modelId: "glm-4.7-flash" },
      },
    ]);
    mocks.loadBotRegistry.mockResolvedValue({
      coding: { group: "main", instructions: "worker" },
    });
    mocks.validateBotConfigs.mockRejectedValue(
      new Error("Bot coding の設定が不正です: 不明なツール名: missing-tool"),
    );

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.initDiscordClients).not.toHaveBeenCalled();
  });

  it("不明なプロバイダーは [startup] ログを出して process.exit(1) する", async () => {
    mocks.loadGroups.mockResolvedValue([
      {
        name: "bad-group",
        channels: [],
        model: { provider: "unknown", modelId: "x" },
      },
    ]);
    mocks.validateGroupConfig.mockImplementation(() => {
      throw new Error("不明なプロバイダ: unknown");
    });

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.registerHandlers).not.toHaveBeenCalled();
  });

  it("不明なツール名は [startup] ログを出して process.exit(1) する", async () => {
    mocks.loadGroups.mockResolvedValue([
      {
        name: "bad-tools-group",
        channels: [],
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: ["unknown_tool"],
      },
    ]);
    mocks.validateGroupConfig.mockImplementation(() => {
      throw new Error("不明なツール名: unknown_tool");
    });

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.registerHandlers).not.toHaveBeenCalled();
  });

  it("不正な mounts 設定は [startup] ログを出して process.exit(1) する", async () => {
    mocks.loadGroups.mockResolvedValue([
      {
        name: "bad-mounts-group",
        channels: [],
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        mounts: [{ host: "../outside", container: "/workspace/x" }],
      },
    ]);
    mocks.validateGroupConfig.mockImplementation(() => {
      throw new Error(
        "mounts.host はリポジトリルート外を指しています: ../outside",
      );
    });

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.registerHandlers).not.toHaveBeenCalled();
  });

  it("cron.json の検証失敗は [startup] ログを出して process.exit(1) する", async () => {
    mocks.loadGroups.mockResolvedValue([
      {
        name: "ok-group",
        channels: [],
        model: { provider: "zai", modelId: "glm-4.7-flash" },
      },
    ]);
    mocks.loadAndValidateCron.mockRejectedValue(
      new Error("ハンドラー jobs/missing.ts が見つかりません"),
    );

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.registerHandlers).not.toHaveBeenCalled();
  });

  it("providers.json の検証失敗は [startup] ログを出して process.exit(1) する", async () => {
    mocks.loadProviders.mockRejectedValue(
      new Error("provider が重複しています: zai"),
    );

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it("strictな起動時コンテナcleanup失敗ではqueue recoveryへ進まない", async () => {
    mocks.killAllRunningContainers.mockRejectedValueOnce(
      new Error("container cleanup discovery failed"),
    );

    await expect(import("./index.js")).rejects.toThrow("process.exit(1)");
    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mocks.killAllRunningContainers).toHaveBeenCalledWith({
      includeOrphans: true,
      strict: true,
    });
    expect(mocks.initializeQueue).not.toHaveBeenCalled();
  });

  it("有効な設定では registerHandlers・startPoller・startDeliveryWorker・login が呼ばれる", async () => {
    mocks.loadGroups.mockResolvedValue([
      {
        name: "ok-group",
        channels: [],
        model: { provider: "zai", modelId: "glm-4.7-flash" },
      },
    ]);

    await import("./index.js");

    expect(mocks.killAllRunningContainers).toHaveBeenCalledWith({
      includeOrphans: true,
      strict: true,
    });
    expect(mocks.initializeQueue).toHaveBeenCalledOnce();
    expect(
      mocks.killAllRunningContainers.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.initializeQueue.mock.invocationCallOrder[0]);
    expect(mocks.registerHandlers).toHaveBeenCalledWith(
      mocks.discordClients.get("personal"),
      expect.any(Function),
      "personal",
    );
    expect(mocks.registerHandlers).toHaveBeenCalledOnce();
    expect(mocks.startPoller).toHaveBeenCalledOnce();
    expect(mocks.startDeliveryWorker).toHaveBeenCalledOnce();
    expect(mocks.loginDiscordClients).toHaveBeenCalledOnce();
  });

  it("複数Botがreadyになっても起動時バックフィルは一度だけ実行する", async () => {
    mocks.discordClients.set("secondary", {
      login: vi.fn(),
      isReady: vi.fn().mockReturnValue(true),
    });
    let releaseBackfill!: () => void;
    mocks.backfillDiscordMessages.mockReturnValue(
      new Promise<void>((resolve) => {
        releaseBackfill = resolve;
      }),
    );

    await import("./index.js");

    expect(mocks.registerHandlers).toHaveBeenCalledTimes(2);
    expect(mocks.registerHandlers).toHaveBeenNthCalledWith(
      1,
      mocks.discordClients.get("personal"),
      expect.any(Function),
      "personal",
    );
    expect(mocks.registerHandlers).toHaveBeenNthCalledWith(
      2,
      mocks.discordClients.get("secondary"),
      expect.any(Function),
      "secondary",
    );
    const firstReady = mocks.registerHandlers.mock
      .calls[0]?.[1] as () => Promise<void>;
    const secondReady = mocks.registerHandlers.mock
      .calls[1]?.[1] as () => Promise<void>;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const firstBackfill = firstReady();
    const secondBackfill = secondReady();
    await vi.waitFor(() =>
      expect(mocks.backfillDiscordMessages).toHaveBeenCalledOnce(),
    );

    releaseBackfill();
    await Promise.all([firstBackfill, secondBackfill]);
    expect(log).toHaveBeenCalledWith(
      "[discord-backfill] 起動時履歴復旧が完了しました",
    );
    log.mockRestore();
  });

  it("shutdown は cron のタイマーを queue worker より先に停止する", async () => {
    const listenersBefore = process.listeners("SIGTERM");
    await import("./index.js");
    const shutdownHandler = process
      .listeners("SIGTERM")
      .find((listener) => !listenersBefore.includes(listener)) as
      | (() => void)
      | undefined;
    if (!shutdownHandler)
      throw new Error("shutdown handler was not registered");

    mockExit.mockImplementation(() => undefined);
    shutdownHandler();
    await vi.waitFor(() => expect(mockExit).toHaveBeenCalledWith(0));

    expect(mocks.stopCron).toHaveBeenCalledOnce();
    expect(mocks.stopPoller).toHaveBeenCalledOnce();
    expect(mocks.stopDeliveryWorker).toHaveBeenCalledOnce();
    expect(mocks.killAllRunningContainers).toHaveBeenCalledTimes(2);
    expect(mocks.stopCron.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stopPoller.mock.invocationCallOrder[0],
    );
    expect(mocks.stopCron.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.stopDeliveryWorker.mock.invocationCallOrder[0],
    );
    expect(mocks.stopDeliveryWorker.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.killAllRunningContainers.mock.invocationCallOrder[1],
    );
  });

  it("reconciles repository and cron RSS paths before final startup observability", async () => {
    mocks.queueRepository.listRssStatePaths.mockReturnValue(["runtime.sqlite"]);
    mocks.loadAndValidateCron.mockResolvedValue([
      {
        handler: "jobs/rss-dispatch.ts",
        settings: { statePath: "cron.sqlite" },
      },
    ]);

    await import("./index.js");

    // RSS state path discovery parses every job payload; startup must run it
    // exactly once and hand the resolved list to both reconciliation and the
    // runtime operator.
    expect(mocks.queueRepository.listRssStatePaths).toHaveBeenCalledOnce();
    expect(mocks.reconcileRssDispatches).toHaveBeenCalledWith(
      mocks.queueRepository,
      ["runtime.sqlite", "cron.sqlite"],
    );
    expect(mocks.runRuntimeOperator).toHaveBeenCalledWith(
      mocks.queueRepository.db,
      expect.objectContaining({
        rssDbPaths: ["runtime.sqlite", "cron.sqlite"],
      }),
    );
    expect(
      mocks.reconcileRssDispatches.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.runRuntimeOperator.mock.invocationCallOrder[0]);
  });
});
