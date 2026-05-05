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

  client.on(Events.MessageCreate, async (message: Message) => {
    // ボット自身のメッセージには反応しない（無限ループ防止）
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(client.user!.id);
    const isThread = message.channel.isThread();

    // DM・メンション・スレッド以外は無視する
    if (!isDM && !isMentioned && !isThread) return;

    const response = await sendMessage(message.channelId, message.content);
    if (response && message.channel.isSendable()) {
      await message.channel.send(response);
    }
  });
}
