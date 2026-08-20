import "dotenv/config";
import { z } from "zod";
import {
  initManager,
  killAllRunningContainers,
  validateGroupConfig,
} from "./agent/manager.js";
import { loadDiscordConfig } from "./config/config.js";
import { loadDefaultModel } from "./config/default-model.js";
import { ensureGroupDirs, initGroupPrompts } from "./config/group-config.js";
import { loadGroups } from "./config/groups.js";
import { loadProviders } from "./config/providers.js";
import {
  _setCronJobs,
  loadAndValidateCron,
  startCron,
  stopCron,
} from "./cron/runner.js";
import { backfillDiscordMessages } from "./discord/backfill.js";
import {
  destroyDiscordClients,
  getDiscordClients,
  initDiscordClients,
  loginDiscordClients,
} from "./discord/client.js";
import { registerHandlers } from "./discord/handler.js";
import { initCredentialProxyServer } from "./proxy/credential-proxy-server.js";
import { startDeliveryWorker, stopDeliveryWorker } from "./queue/delivery.js";
import { initializeQueue } from "./queue/migration.js";
import { runRuntimeOperator } from "./queue/operator.js";
import { startPoller, stopPoller } from "./queue/poller.js";
import { reconcileRssDispatches } from "./queue/reconciliation.js";
import { getQueueRepository } from "./queue/repository.js";
import type { GroupConfig } from "./config/groups.js";
import type { QueueRepository } from "./queue/repository.js";
import type { Client } from "discord.js";

export interface StartupDependencies {
  loadGroups: () => Promise<GroupConfig[]>;
  loadDiscordConfig: typeof loadDiscordConfig;
  initDiscordClients: typeof initDiscordClients;
  getDiscordClients: () => ReadonlyMap<string, Client>;
  ensureGroupDirs: (names: string[]) => Promise<void>;
  initCredentialProxyServer: () => Promise<number>;
  initManager: typeof initManager;
  initGroupPrompts: typeof initGroupPrompts;
  loadProviders: typeof loadProviders;
  loadDefaultModel: typeof loadDefaultModel;
  validateGroupConfig: typeof validateGroupConfig;
  getQueueRepository: () => QueueRepository;
  initializeQueue: typeof initializeQueue;
  loadAndValidateCron: typeof loadAndValidateCron;
  reconcileRssDispatches: typeof reconcileRssDispatches;
  runRuntimeOperator: typeof runRuntimeOperator;
  setCronJobs: typeof _setCronJobs;
  registerHandlers: typeof registerHandlers;
  backfillDiscordMessages: typeof backfillDiscordMessages;
  startPoller: typeof startPoller;
  startDeliveryWorker: typeof startDeliveryWorker;
  startCron: typeof startCron;
  loginDiscordClients: typeof loginDiscordClients;
  stopCron: typeof stopCron;
  stopPoller: typeof stopPoller;
  stopDeliveryWorker: typeof stopDeliveryWorker;
  killAllRunningContainers: typeof killAllRunningContainers;
  destroyDiscordClients: typeof destroyDiscordClients;
  exit: (code: number) => void;
}

const defaultDependencies: StartupDependencies = {
  loadGroups, loadDiscordConfig, initDiscordClients, getDiscordClients,
  ensureGroupDirs, initCredentialProxyServer, initManager, initGroupPrompts,
  loadProviders, loadDefaultModel, validateGroupConfig, getQueueRepository,
  initializeQueue, loadAndValidateCron, reconcileRssDispatches,
  runRuntimeOperator, setCronJobs: _setCronJobs, registerHandlers,
  backfillDiscordMessages, startPoller, startDeliveryWorker, startCron,
  loginDiscordClients, stopCron, stopPoller, stopDeliveryWorker,
  killAllRunningContainers, destroyDiscordClients, exit: process.exit,
};

export async function startApp(
  deps: StartupDependencies = defaultDependencies,
): Promise<void> {
  const groups = await deps.loadGroups();
  try {
    const discordConfig = await deps.loadDiscordConfig();
    for (const group of groups) {
    if (group.bot && !(group.bot in discordConfig.bots))
      throw new Error(
        `Group ${group.name} のDiscord Botが未定義です: ${group.bot}`,
      );
  }
    await deps.initDiscordClients();
    await deps.ensureGroupDirs(groups.map((g) => g.name));
    const proxyPort = await deps.initCredentialProxyServer();
    await deps.initManager(proxyPort);
    await deps.initGroupPrompts(groups);
    await deps.loadProviders();
    const defaultModel = await deps.loadDefaultModel();
    await Promise.all(groups.map((g) => deps.validateGroupConfig(g, defaultModel)));
    const queueRepository = deps.getQueueRepository();
    await deps.initializeQueue(queueRepository);
    const cronJobs = await deps.loadAndValidateCron();
  const rssStatePaths = [
    ...queueRepository.listRssStatePaths(),
    ...cronJobs.flatMap((job) => {
      if (
        !job.handler?.endsWith("rss-dispatch.ts")
      )
        return [];
      const settings = job.settings;
      const statePath = z
        .object({ statePath: z.string().min(1) })
        .safeParse(settings).data?.statePath;
      return statePath ? [statePath] : [];
    }),
  ];
  // Reconcile before collecting startup metrics so crash-window claims do not
  // produce transient orphan/tombstone alerts.
    deps.reconcileRssDispatches(queueRepository, rssStatePaths);
  const staleAfterMs = Number(process.env.RUNTIME_STALE_AFTER_MS);
    const runtimeOperator = await deps.runRuntimeOperator(queueRepository.db, {
    rssDbPaths: rssStatePaths,
    staleAfterMs: Number.isFinite(staleAfterMs) ? staleAfterMs : undefined,
    backupPath: process.env.RUNTIME_BACKUP_PATH,
  });
  if (!runtimeOperator.health.ok)
    console.warn(
      "[startup] runtime database health check failed",
      runtimeOperator.health,
    );
  for (const alert of runtimeOperator.observability.alerts)
    console.warn(`[startup] ${alert}`);
    deps.setCronJobs(cronJobs);
  } catch (err) {
    console.error("[startup] 設定の読み込みに失敗しました:", err);
    deps.exit(1);
    return;
  }

let backfillStarted = false;
const runStartupBackfillOnce = async (): Promise<void> => {
  if (backfillStarted) return;
  backfillStarted = true;
  console.log("[discord-backfill] 起動時履歴復旧を開始します");
    await deps.backfillDiscordMessages(groups);
  console.log("[discord-backfill] 起動時履歴復旧が完了しました");
};
  for (const discordClient of deps.getDiscordClients().values()) {
    deps.registerHandlers(discordClient, runStartupBackfillOnce);
  }
  deps.startPoller();
  deps.startDeliveryWorker(deps.getQueueRepository());
  deps.startCron();
  void deps.loginDiscordClients();

// spawn した docker run 子プロセス（ひいてはコンテナ本体）は process.exit() しても
// 自動では止まらず孤立するため、実行中コンテナを docker kill してから終了する。
const shutdown = async (): Promise<void> => {
    deps.stopCron();
    deps.stopPoller();
    deps.stopDeliveryWorker();
    await deps.killAllRunningContainers();
    await deps.destroyDiscordClients();
    deps.exit(0);
  };
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("SIGINT", () => {
    void shutdown();
  });
}

if (process.env.NODE_ENV !== "test") {
  await startApp();
}
