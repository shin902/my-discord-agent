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

    // スレッドの場合は親チャンネルIDで設定を検索する
    const lookupId =
      message.channel.isThread() && message.channel.parentId
        ? message.channel.parentId
        : message.channelId;

    const match = await findGroupByChannelId(lookupId);
    if (!match) return;

    let sessionId: string;

    if (match.channel.sessionMode === 'shared') {
      if (message.channel.isThread()) return;
      sessionId = message.channelId;
    } else if (match.channel.sessionMode === 'thread') {
      if (!message.channel.isThread()) return;
      sessionId = message.channelId; // スレッドIDがそのままセッションID
    } else {
      console.log(`[handler] sessionMode=${match.channel.sessionMode} は未実装のためスキップ: ${message.channelId}`);
      return;
    }

    console.log(`[handler] inbox に積みます: ${message.channelId} "${message.content}"`);
    await appendInbox({
      channelId: message.channelId,
      groupName: match.group.name,
      sessionId,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
    }).catch(async (err) => {
      console.error('[handler] appendInbox 失敗:', err);
      await message.reply('メッセージの受信に失敗しました。もう一度送ってください。');
    });
  });
}
