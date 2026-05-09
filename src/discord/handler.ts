import { Events, Message } from 'discord.js';
import { client } from './client.js';
import { appendInbox } from '../queue/inbox.js';
import { findGroupByChannelId } from '../config/groups.js';

/**
 * Discord のイベントハンドラーを登録する。
 * index.ts から一度だけ呼ぶ。
 */
export function registerHandlers(): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`起動しました: ${c.user.tag}`);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    const match = await findGroupByChannelId(message.channelId);
    if (!match) return;

    if (match.channel.sessionMode !== 'shared') {
      console.log(`[handler] sessionMode=${match.channel.sessionMode} は未実装のためスキップ: ${message.channelId}`);
      return;
    }

    console.log(`[handler] inbox に積みます: ${message.channelId} "${message.content}"`);
    await appendInbox({
      channelId: message.channelId,
      groupName: match.group.name,
      sessionId: message.channelId,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
    }).catch(async (err) => {
      console.error('[handler] appendInbox 失敗:', err);
      await message.reply('メッセージの受信に失敗しました。もう一度送ってください。');
    });
  });
}
