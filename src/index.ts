import "dotenv/config";
import { handleBotToolRequest } from "./agent/bot-orchestration.js";
import {
  initManager,
  killAllRunningContainers,
  validateGroupConfig,
} from "./agent/manager.js";
import { loadBotRegistry, validateBotConfigs } from "./config/bots.js";
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
import {
  initCredentialProxyServer,
  registerInternalRequestHandler,
} from "./proxy/credential-proxy-server.js";
import { startDeliveryWorker, stopDeliveryWorker } from "./queue/delivery.js";
import { initializeQueue } from "./queue/migration.js";
import { runRuntimeOperator } from "./queue/operator.js";
import { startPoller, stopPoller } from "./queue/poller.js";
import { reconcileRssDispatches } from "./queue/reconciliation.js";
import { getQueueRepository } from "./queue/repository.js";

const groups = await loadGroups();
try {
  const discordConfig = await loadDiscordConfig();
  const botRegistry = await loadBotRegistry();
  for (const group of groups) {
    if (group.bot && !(group.bot in discordConfig.bots))
      throw new Error(
        `Group ${group.name} のDiscord Botが未定義です: ${group.bot}`,
      );
  }
  await ensureGroupDirs(groups.map((g) => g.name));
  const proxyPort = await initCredentialProxyServer();
  registerInternalRequestHandler(handleBotToolRequest);
  await initManager(proxyPort);
  // Stop containers left by a previous process before recovering its
  // direct-admission markers.
  await killAllRunningContainers({ includeOrphans: true, strict: true });
  await initGroupPrompts(groups);
  await loadProviders();
  const defaultModel = await loadDefaultModel();
  await Promise.all(groups.map((g) => validateGroupConfig(g, defaultModel)));
  await validateBotConfigs(groups, botRegistry, defaultModel);
  await initDiscordClients();
  const queueRepository = getQueueRepository();
  await initializeQueue(queueRepository);
  const cronJobs = await loadAndValidateCron();
  const rssStatePaths = [
    ...queueRepository.listRssStatePaths(),
    ...cronJobs.flatMap((job) => {
      if (
        typeof job.handler !== "string" ||
        !job.handler.endsWith("rss-dispatch.ts")
      )
        return [];
      const settings = job.settings;
      if (
        !settings ||
        typeof settings !== "object" ||
        Array.isArray(settings) ||
        !("statePath" in settings)
      )
        return [];
      const statePath = settings.statePath;
      return typeof statePath === "string" && statePath.length > 0
        ? [statePath]
        : [];
    }),
  ];
  // Reconcile before collecting startup metrics so crash-window claims do not
  // produce transient orphan/tombstone alerts.
  reconcileRssDispatches(queueRepository, rssStatePaths);
  const staleAfterMs = Number(process.env.RUNTIME_STALE_AFTER_MS);
  const runtimeOperator = await runRuntimeOperator(queueRepository.db, {
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
  _setCronJobs(cronJobs);
} catch (err) {
  console.error("[startup] 設定の読み込みに失敗しました:", err);
  process.exit(1);
}

let backfillStarted = false;
const runStartupBackfillOnce = async (): Promise<void> => {
  if (backfillStarted) return;
  backfillStarted = true;
  console.log("[discord-backfill] 起動時履歴復旧を開始します");
  await backfillDiscordMessages(groups);
  console.log("[discord-backfill] 起動時履歴復旧が完了しました");
};
for (const [discordBotId, discordClient] of getDiscordClients()) {
  registerHandlers(discordClient, runStartupBackfillOnce, discordBotId);
}
startPoller();
startDeliveryWorker(getQueueRepository());
startCron();
void loginDiscordClients();

// spawn した docker run 子プロセス（ひいてはコンテナ本体）は process.exit() しても
// 自動では止まらず孤立するため、実行中コンテナを docker kill してから終了する。
const shutdown = async (): Promise<void> => {
  stopCron();
  stopPoller();
  stopDeliveryWorker();
  await killAllRunningContainers();
  await destroyDiscordClients();
  process.exit(0);
};
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
