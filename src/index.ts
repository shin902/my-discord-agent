import "dotenv/config";
import { initManager, validateGroupConfig } from "./agent/manager.js";
import { loadDefaultModel } from "./config/default-model.js";
import { ensureGroupDirs, initGroupPrompts } from "./config/group-config.js";
import { loadGroups } from "./config/groups.js";
import { startCron, stopCron } from "./cron/runner.js";
import { client } from "./discord/client.js";
import { registerHandlers } from "./discord/handler.js";
import { initCredentialProxyServer } from "./proxy/credential-proxy-server.js";
import { startPoller, stopPoller } from "./queue/poller.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN が設定されていません");

const groups = await loadGroups();
try {
  await ensureGroupDirs(groups.map((g) => g.name));
  const proxyPort = await initCredentialProxyServer();
  await initManager(proxyPort);
  await initGroupPrompts(groups);
  const defaultModel = await loadDefaultModel();
  for (const group of groups) {
    await validateGroupConfig(group, defaultModel);
  }
} catch (err) {
  console.error("[startup] 設定の読み込みに失敗しました:", err);
  process.exit(1);
}

registerHandlers();
startPoller();
startCron();
client.login(token);

process.on("SIGTERM", () => {
  stopPoller();
  stopCron();
  process.exit(0);
});
process.on("SIGINT", () => {
  stopPoller();
  stopCron();
  process.exit(0);
});
