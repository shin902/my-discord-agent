import { Events, Message } from 'discord.js';
import { client } from './client.js';
import { sendMessage } from '../agent/manager.js';

/**
 * Discord のイベントハンドラーを登録する。
 * index.ts から一度だけ呼ぶ。
 */
export function registerHandlers(): void {
  // ボット起動完了時のログ
  client.once(Events.ClientReady, (c) => {
    console.log(`起動しました: ${c.user.tag}`);
  });

  // メッセージ受信時の処理。MessageCreate イベント
  client.on(Events.MessageCreate, async (message: Message) => {
    // ボット自身のメッセージには反応しない（無限ループ防止）
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user!.id);
    const isThread = message.channel.isThread();

    // DM・メンション・スレッド以外は無視する
    if (!isDM && !isMentioned && !isThread) return;

    // ここで、message.content を Agent Manager に渡して応答を得る
    const response = await sendMessage(message.channelId, message.content);
    console.log(`Received message: ${message.content}`);
    if (response && message.channel.isSendable()) {
      // 残るのはDM/メンション/スレッドのいずれか。普通のチャットでは反応しない。
      // 実際にDiscordに送信
      await message.channel.send(response);
    }
  });
}
