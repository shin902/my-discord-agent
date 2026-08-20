import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "discord.js";
import type { StartupDependencies } from "./index.js";
import { QueueRepository } from "./queue/repository.js";

function makeDependencies(): StartupDependencies {
  const repository = new QueueRepository(":memory:");
  const clients = new Map<string, Client>([["personal", new Client({ intents: [] })]]);
  const exit = vi.fn((code: number): void => {
    throw new Error(`process.exit(${code})`);
  });
  return {
    loadGroups: vi.fn().mockResolvedValue([]),
    loadDiscordConfig: vi.fn().mockResolvedValue({ bots: {} }),
    initDiscordClients: vi.fn().mockResolvedValue(undefined),
    getDiscordClients: vi.fn(() => clients),
    ensureGroupDirs: vi.fn().mockResolvedValue(undefined),
    initCredentialProxyServer: vi.fn().mockResolvedValue(0),
    initManager: vi.fn().mockResolvedValue(undefined),
    initGroupPrompts: vi.fn().mockResolvedValue(undefined),
    loadProviders: vi.fn().mockResolvedValue([]),
    loadDefaultModel: vi.fn().mockResolvedValue({ provider: "zai", modelId: "glm-4.7-flash" }),
    validateGroupConfig: vi.fn().mockResolvedValue(undefined),
    getQueueRepository: vi.fn(() => repository),
    initializeQueue: vi.fn().mockResolvedValue(undefined),
    loadAndValidateCron: vi.fn().mockResolvedValue([]),
    reconcileRssDispatches: vi.fn(),
    runRuntimeOperator: vi.fn().mockResolvedValue({ health: { ok: true }, observability: { alerts: [] } }),
    setCronJobs: vi.fn(),
    registerHandlers: vi.fn(),
    backfillDiscordMessages: vi.fn().mockResolvedValue(undefined),
    startPoller: vi.fn(),
    startDeliveryWorker: vi.fn(),
    startCron: vi.fn(),
    loginDiscordClients: vi.fn().mockResolvedValue(undefined),
    stopCron: vi.fn(),
    stopPoller: vi.fn(),
    stopDeliveryWorker: vi.fn(),
    killAllRunningContainers: vi.fn().mockResolvedValue(undefined),
    destroyDiscordClients: vi.fn().mockResolvedValue(undefined),
    exit,
  };
}

const group = (name: string) => ({ name, channels: [], model: { provider: "zai", modelId: "glm-4.7-flash" } });

afterEach(() => vi.restoreAllMocks());

describe("index: 起動時バリデーション", () => {
  it("DISCORD_BOT_TOKEN 未設定は起動時にスロー", async () => {
    const deps = makeDependencies();
    deps.loadDiscordConfig = vi.fn().mockRejectedValue(new Error("DISCORD_BOT_TOKEN が設定されていません"));
    await expect(import("./index.js").then(({ startApp }) => startApp(deps))).rejects.toThrow("process.exit(1)");
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    ["不明なプロバイダー", "不明なプロバイダ: unknown", group("bad-group")],
    ["不明なツール名", "不明なツール名: unknown_tool", { ...group("bad-tools-group"), tools: ["unknown_tool"] }],
    ["不正な mounts 設定", "mounts.host はリポジトリルート外を指しています: ../outside", { ...group("bad-mounts-group"), mounts: [{ host: "../outside", container: "/workspace/x" }] }],
  ])("%s は [startup] ログを出して process.exit(1) する", async (_name, message, config) => {
    const deps = makeDependencies();
    deps.loadGroups = vi.fn().mockResolvedValue([config]);
    deps.validateGroupConfig = vi.fn().mockImplementation(() => { throw new Error(message); });
    await expect(import("./index.js").then(({ startApp }) => startApp(deps))).rejects.toThrow("process.exit(1)");
    expect(deps.exit).toHaveBeenCalledWith(1);
    expect(deps.registerHandlers).not.toHaveBeenCalled();
  });

  it("cron.json/providers.json の検証失敗は process.exit(1) する", async () => {
    const deps = makeDependencies();
    deps.loadAndValidateCron = vi.fn().mockRejectedValue(new Error("ハンドラー jobs/missing.ts が見つかりません"));
    await expect(import("./index.js").then(({ startApp }) => startApp(deps))).rejects.toThrow("process.exit(1)");
    expect(deps.exit).toHaveBeenCalledWith(1);
    const providers = makeDependencies();
    providers.loadProviders = vi.fn().mockRejectedValue(new Error("provider が重複しています: zai"));
    await expect(import("./index.js").then(({ startApp }) => startApp(providers))).rejects.toThrow("process.exit(1)");
  });

  it("有効な設定では主要な起動処理が呼ばれる", async () => {
    const deps = makeDependencies();
    deps.loadGroups = vi.fn().mockResolvedValue([group("ok-group")]);
    await import("./index.js").then(({ startApp }) => startApp(deps));
    expect(deps.registerHandlers).toHaveBeenCalledOnce();
    expect(deps.startPoller).toHaveBeenCalledOnce();
    expect(deps.startDeliveryWorker).toHaveBeenCalledOnce();
    expect(deps.loginDiscordClients).toHaveBeenCalledOnce();
  });

  it("複数Botでも起動時バックフィルは一度だけ実行する", async () => {
    const deps = makeDependencies();
    deps.getDiscordClients = vi.fn(() => new Map([["a", new Client({ intents: [] })], ["b", new Client({ intents: [] })]]));
    let release!: () => void;
    deps.backfillDiscordMessages = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const callbacks: Array<() => Promise<void>> = [];
    deps.registerHandlers = (client, callback) => {
      if (callback) callbacks.push(async () => { await callback(); });
    };
    await import("./index.js").then(({ startApp }) => startApp(deps));
    expect(callbacks).toHaveLength(2);
    const first = callbacks[0]?.();
    const second = callbacks[1]?.();
    await vi.waitFor(() => expect(deps.backfillDiscordMessages).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
  });

  it("shutdown は cron、queue worker、コンテナの順に停止する", async () => {
    const deps = makeDependencies();
    await import("./index.js").then(({ startApp }) => startApp(deps));
    const handler = process.listeners("SIGTERM").at(-1);
    expect(handler).toBeDefined();
    const exit = vi.spyOn(deps, "exit");
    exit.mockImplementation(() => undefined);
    handler?.("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(deps.stopCron).toHaveBeenCalledOnce();
    expect(deps.stopPoller).toHaveBeenCalledOnce();
    expect(deps.stopDeliveryWorker).toHaveBeenCalledOnce();
    expect(deps.killAllRunningContainers).toHaveBeenCalledOnce();
  });

  it("RSS state paths are reconciled before runtime observability", async () => {
    const deps = makeDependencies();
    const repository = deps.getQueueRepository();
    vi.spyOn(repository, "listRssStatePaths").mockReturnValue(["runtime.sqlite"]);
    deps.loadAndValidateCron = vi.fn().mockResolvedValue([{ handler: "jobs/rss-dispatch.ts", settings: { statePath: "cron.sqlite" } }]);
    await import("./index.js").then(({ startApp }) => startApp(deps));
    expect(deps.reconcileRssDispatches).toHaveBeenCalledWith(repository, ["runtime.sqlite", "cron.sqlite"]);
    expect(deps.runRuntimeOperator).toHaveBeenCalledWith(repository.db, expect.objectContaining({ rssDbPaths: ["runtime.sqlite", "cron.sqlite"] }));
  });
});
