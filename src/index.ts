import 'dotenv/config';
import { client } from './discord/client.js';
import { registerHandlers } from './discord/handler.js';
import { startPoller, stopPoller } from './queue/poller.js';
import { loadGroups } from './config/groups.js';
import { initGroupConfigs, loadGroupConfig } from './config/group-config.js';
import { resolveModel, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from './agent/manager.js';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN が設定されていません');

// 起動時に設定を一括読み込みしてキャッシュ
const groups = await loadGroups();
await initGroupConfigs(groups.map((g) => g.name));

// 不明なプロバイダー・モデルは起動時に即クラッシュ
for (const group of groups) {
  const config = await loadGroupConfig(group.name);
  resolveModel(
    config.model?.provider ?? DEFAULT_PROVIDER,
    config.model?.modelId ?? DEFAULT_MODEL_ID,
  );
}

registerHandlers();
startPoller();
client.login(token);

process.on('SIGTERM', () => { stopPoller(); process.exit(0); });
process.on('SIGINT',  () => { stopPoller(); process.exit(0); });
