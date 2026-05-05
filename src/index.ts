import { client } from './discord/client.js';
import { registerHandlers } from './discord/handler.js';

const token = process.env.DISCORD_BOT_TOKEN;
if (!token) throw new Error('DISCORD_BOT_TOKEN が設定されていません');

// イベントハンドラーを登録してから Discord に接続する
registerHandlers();
client.login(token);
