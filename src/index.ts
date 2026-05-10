import "dotenv/config";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  validateModel,
} from "./agent/manager.js";
import { initGroupConfigs } from "./config/group-config.js";
import { loadGroups } from "./config/groups.js";
import { client } from "./discord/client.js";
import { registerHandlers } from "./discord/handler.js";
import { startPoller, stopPoller } from "./queue/poller.js";

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error("DISCORD_BOT_TOKEN が設定されていません");

const groups = await loadGroups();
try {
  const configs = await initGroupConfigs(groups.map((g) => g.name));
  for (const group of groups) {
    const config = configs.get(group.name);
    if (config === undefined) {
      throw new Error(`グループ "${group.name}" の設定が見つかりません`);
    }
    validateModel(
      config.model?.provider ?? DEFAULT_PROVIDER,
      config.model?.modelId ?? DEFAULT_MODEL_ID,
    );
  }
} catch (err) {
  console.error("[startup] 設定の読み込みに失敗しました:", err);
  process.exit(1);
}

registerHandlers();
startPoller();
client.login(token);

process.on("SIGTERM", () => {
  stopPoller();
  process.exit(0);
});
process.on("SIGINT", () => {
  stopPoller();
  process.exit(0);
});
