import { Client, GatewayIntentBits } from 'discord.js';

/**
 * Discord クライアントのシングルトン。
 * Intents はボットが受け取るイベントの種類を指定する。
 * - Guilds: サーバー情報
 * - GuildMessages: サーバー内メッセージ
 * - MessageContent: メッセージ本文（特権インテント。Developer Portal で有効化が必要）
 * - DirectMessages: DM
 */
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});
