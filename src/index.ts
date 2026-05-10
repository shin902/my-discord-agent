import 'dotenv/config';
import { client } from './discord/client.js';
import { registerHandlers } from './discord/handler.js';
import { startPoller, stopPoller } from './queue/poller.js';
import { loadGroups } from './config/groups.js';
import { initGroupConfigs } from './config/group-config.js';
import { validateModel, DEFAULT_PROVIDER, DEFAULT_MODEL_ID } from './agent/manager.js';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN が設定されていません');

const groups = await loadGroups();
try {
  const configs = await initGroupConfigs(groups.map((g) => g.name));
  for (const group of groups) {
    const config = configs.get(group.name)!;
    validateModel(config.model?.provider ?? DEFAULT_PROVIDER, config.model?.modelId ?? DEFAULT_MODEL_ID);
  }
} catch (err) {
  console.error('[startup] 設定の読み込みに失敗しました:', err);
  process.exit(1);
}

registerHandlers();
startPoller();
client.login(token);

process.on('SIGTERM', () => { stopPoller(); process.exit(0); });
process.on('SIGINT', () => { stopPoller(); process.exit(0); });
