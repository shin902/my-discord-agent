import 'dotenv/config';
import { client } from './discord/client.js';
import { registerHandlers } from './discord/handler.js';
import { startPoller, stopPoller } from './queue/poller.js';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN が設定されていません');

registerHandlers();
startPoller();
client.login(token);

process.on('SIGTERM', () => { stopPoller(); process.exit(0); });
process.on('SIGINT',  () => { stopPoller(); process.exit(0); });
