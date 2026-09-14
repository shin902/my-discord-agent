import "dotenv/config";
import type { Server } from "node:http";
import { handleBotToolRequest } from "./agent/bot-orchestration.js";
import {
  beginManagerShutdown,
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
import { loadScreenCaptureReceiverConfig } from "./config/screen-capture.js";
import {
  loadXSavedGalleryConfig,
  loadXSavedReceiverConfig,
} from "./config/x-saved.js";
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
import { presentToolApprovalRequest } from "./discord/tool-approval.js";
import { startScreenCaptureReceiver } from "./integrations/screen-capture/receiver.js";
import { startXSavedGallery } from "./integrations/x-saved/gallery.js";
import { startXSavedReceiver } from "./integrations/x-saved/receiver.js";
import {
  initCredentialProxyServer,
  registerInternalRequestHandler,
} from "./proxy/credential-proxy-server.js";
import { initToolCredentials } from "./proxy/tool-credentials.js";
import {
  initToolProxyServer,
  stopToolProxyServer,
} from "./proxy/tool-proxy-server.js";
import { startDeliveryWorker, stopDeliveryWorker } from "./queue/delivery.js";
import { initializeQueue } from "./queue/migration.js";
import { runRuntimeOperator } from "./queue/operator.js";
import { startPoller, stopPoller } from "./queue/poller.js";
import { reconcileRssDispatches } from "./queue/reconciliation.js";
import { getQueueRepository } from "./queue/repository.js";

import {
  cleanupToolRuntimes,
  stopToolRuntimes,
} from "./runtime/tool-runtime-client.js";

const groups = await loadGroups();
let xSavedReceiver: Server | undefined;
let screenCaptureReceiver: Server | undefined;
let xSavedGallery: Server | undefined;
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
  await initToolCredentials();
  const proxyPort = await initCredentialProxyServer();
  const toolProxyPort = await initToolProxyServer({
    presentApprovalRequest: presentToolApprovalRequest,
  });
  registerInternalRequestHandler(handleBotToolRequest);
  await initManager(proxyPort, toolProxyPort);
  // Stop managed and orphan containers before startup recovery.
  await cleanupToolRuntimes();
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
  const xSavedConfig = await loadXSavedReceiverConfig();
  const galleryConfig = await loadXSavedGalleryConfig();
  if (
    xSavedConfig.enabled &&
    galleryConfig.enabled &&
    xSavedConfig.port === galleryConfig.port
  ) {
    throw new Error("x-saved receiver and gallery require separate ports");
  }
  if (xSavedConfig.enabled) {
    xSavedReceiver = await startXSavedReceiver({ port: xSavedConfig.port });
  }
  const screenCaptureConfig = await loadScreenCaptureReceiverConfig();
  if (screenCaptureConfig.enabled) {
    screenCaptureReceiver = await startScreenCaptureReceiver({
      port: screenCaptureConfig.port,
    });
  }
  if (galleryConfig.enabled && galleryConfig.origin) {
    xSavedGallery = await startXSavedGallery({
      port: galleryConfig.port,
      origin: galleryConfig.origin,
    });
  }
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
  beginManagerShutdown();
  for (const server of [xSavedReceiver, screenCaptureReceiver, xSavedGallery]) {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  stopCron();
  stopPoller();
  stopDeliveryWorker();
  await stopToolProxyServer();
  await Promise.all([killAllRunningContainers(), stopToolRuntimes()]);
  await destroyDiscordClients();
  process.exit(0);
};
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("SIGINT", () => {
  void shutdown();
});
