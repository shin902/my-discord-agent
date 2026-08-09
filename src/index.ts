import "dotenv/config";
import {
  initManager,
  killAllRunningContainers,
  validateGroupConfig,
} from "./agent/manager.js";
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
import { client } from "./discord/client.js";
import { registerHandlers } from "./discord/handler.js";
import { initCredentialProxyServer } from "./proxy/credential-proxy-server.js";
import { startDeliveryWorker, stopDeliveryWorker } from "./queue/delivery.js";
import { initializeQueue } from "./queue/migration.js";
import { runRuntimeOperator } from "./queue/operator.js";
import { startPoller, stopPoller } from "./queue/poller.js";
import { reconcileRssDispatches } from "./queue/reconciliation.js";
import { getQueueRepository } from "./queue/repository.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN が設定されていません");

const groups = await loadGroups();
try {
  await ensureGroupDirs(groups.map((g) => g.name));
  const proxyPort = await initCredentialProxyServer();
  await initManager(proxyPort);
  await initGroupPrompts(groups);
  await loadProviders();
  const defaultModel = await loadDefaultModel();
  await Promise.all(groups.map((g) => validateGroupConfig(g, defaultModel)));
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

registerHandlers();
startPoller();
startDeliveryWorker(getQueueRepository());
startCron();
void client.login(token);

// spawn した docker run 子プロセス（ひいてはコンテナ本体）は process.exit() しても
// 自動では止まらず孤立するため、実行中コンテナを docker kill してから終了する。
const shutdown = async (): Promise<void> => {
  stopCron();
  stopPoller();
  stopDeliveryWorker();
  await killAllRunningContainers();
  process.exit(0);
};
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
