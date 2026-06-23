import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.resetModules() 後も同じ関数参照を保つためにホイスト
const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  registerHandlers: vi.fn(),
  startPoller: vi.fn(),
  loadGroups: vi.fn(),
  initGroupPrompts: vi.fn(),
  initManager: vi.fn(),
  validateGroupConfig: vi.fn(),
  loadDefaultModel: vi.fn(),
  loadAndValidateCron: vi.fn(),
}));

vi.mock("./discord/client.js", () => ({ client: { login: mocks.login } }));
vi.mock("./discord/handler.js", () => ({
  registerHandlers: mocks.registerHandlers,
}));
vi.mock("./queue/poller.js", () => ({
  startPoller: mocks.startPoller,
  stopPoller: vi.fn(),
}));
vi.mock("./config/groups.js", () => ({ loadGroups: mocks.loadGroups }));
vi.mock("./config/group-config.js", () => ({
  ensureGroupDirs: vi.fn().mockResolvedValue(undefined),
  initGroupPrompts: mocks.initGroupPrompts,
}));
vi.mock("./agent/manager.js", () => ({
  initManager: mocks.initManager,
  validateGroupConfig: mocks.validateGroupConfig,
}));
vi.mock("./config/default-model.js", () => ({
  loadDefaultModel: mocks.loadDefaultModel,
}));
vi.mock("./proxy/credential-proxy-server.js", () => ({
  initCredentialProxyServer: vi.fn().mockResolvedValue(0),
}));
vi.mock("./cron/runner.js", () => ({
  startCron: vi.fn(),
  stopCron: vi.fn(),
  loadAndValidateCron: mocks.loadAndValidateCron,
  _setCronJobs: vi.fn(),
}));
vi.mock("dotenv/config", () => ({}));

describe("index: 起動時バリデーション", () => {
  const ORIGINAL_TOKEN = process.env.DISCORD_BOT_TOKEN;
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    process.env.DISCORD_BOT_TOKEN = "test-token";
    mocks.loadGroups.mockResolvedValue([]);
    mocks.initManager.mockResolvedValue(undefined);
    mocks.initGroupPrompts.mockResolvedValue(undefined);
    mocks.loadDefaultModel.mockResolvedValue({
      provider: "zai",
      modelId: "glm-4.7-flash",
    });
    mocks.loadAndValidateCron.mockResolvedValue([]);
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
    await expect(import("./index.js")).rejects.toThrow(
      "DISCORD_BOT_TOKEN が設定されていません",
    );
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

  it("有効な設定では registerHandlers・startPoller・login が呼ばれる", async () => {
    mocks.loadGroups.mockResolvedValue([
      {
        name: "ok-group",
        channels: [],
        model: { provider: "zai", modelId: "glm-4.7-flash" },
      },
    ]);

    await import("./index.js");

    expect(mocks.registerHandlers).toHaveBeenCalledOnce();
    expect(mocks.startPoller).toHaveBeenCalledOnce();
    expect(mocks.login).toHaveBeenCalledWith("test-token");
  });
});
