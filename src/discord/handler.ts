import { Events, Message } from 'discord.js';
import { client } from './client.js';
import { appendInbox } from '../queue/inbox.js';

/**
 * Discord のイベントハンドラーを登録する。
 * index.ts から一度だけ呼ぶ。
 */
export function registerHandlers(): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`起動しました: ${c.user.tag}`);
    console.log(`[handler] cwd: ${process.cwd()}`);
  });

  // メッセージ受信イベント。
  // handler の責務は「キューに積むだけ」。処理は poller.ts が担う。
  client.on(Events.MessageCreate, async (message: Message) => {
    // bot のメッセージは無視。自分自身の返信で無限ループになるのを防ぐ。
    if (message.author.bot) return;

    const isDM = !message.guild;                                // guild がなければ DM
    const isMentioned = message.mentions.has(client.user!.id);  // @bot のメンション
    const isThread = message.channel.isThread();                // スレッド内の発言

    // DM・メンション・スレッドのいずれでもなければ無視。
    // サーバーの一般チャンネルで bot 宛てでない会話には反応しない。
    if (!isDM && !isMentioned && !isThread) return;

    // inbox に積んで即リターン。応答は poller.ts が非同期で行う。
    console.log(`[handler] inbox に積みます: ${message.channelId} "${message.content}"`);
    await appendInbox({
      channelId: message.channelId,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
    }).catch(async (err) => {
      console.error('[handler] appendInbox 失敗:', err);
      await message.reply('メッセージの受信に失敗しました。もう一度送ってください。');
    });
  });
}
