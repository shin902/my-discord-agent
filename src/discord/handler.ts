import { Events, ThreadAutoArchiveDuration, type Message } from "discord.js";
import { findGroupByChannelId } from "../config/groups.js";
import { appendInbox } from "../queue/inbox.js";
import { client } from "./client.js";

// URL あり → "{hostname}-{messageId末尾6文字}", URL なし → "thread-{messageId末尾6文字}", 最大100文字
function buildThreadName(content: string, messageId: string): string {
  const suffix = messageId.slice(-6);
  const urlMatch = /https?:\/\/[^\s<>()]+/iu.exec(content);
  if (urlMatch) {
    try {
      const hostname = new URL(urlMatch[0]).hostname.replace(/\./g, "-");
      return `${hostname}-${suffix}`.slice(0, 100);
    } catch {
      // URL パースに失敗したら fallthrough
    }
  }
  return `thread-${suffix}`;
}

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
    let inboxChannelId = message.channelId;

    if (match.channel.sessionMode === "shared") {
      if (message.channel.isThread()) return;
      sessionId = message.channelId;
    } else if (match.channel.sessionMode === "thread") {
      if (!message.channel.isThread()) return;
      sessionId = message.channelId; // スレッドIDがそのままセッションID
    } else if (match.channel.sessionMode === "auto-thread") {
      if (message.channel.isThread()) {
        sessionId = message.channelId;
      } else {
        const threadName = buildThreadName(message.content, message.id);
        let thread: { id: string };
        try {
          thread = await message.startThread({
            name: threadName,
            autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          });
        } catch (err) {
          console.error("[handler] スレッド作成失敗:", err);
          await message
            .reply("スレッドの作成に失敗しました。もう一度送ってください。")
            .catch((e) => console.error("[handler] reply 失敗:", e));
          return;
        }
        sessionId = thread.id;
        inboxChannelId = thread.id;
      }
    } else {
      // Zod が loadGroups() 時点で未知の sessionMode を弾くため、ここには到達しない。
      // 新しいモードを groups.ts の enum に追加したときの対応漏れをコンパイルエラーで検知する。
      const _: never = match.channel.sessionMode;
      return;
    }

    console.log(
      `[handler] inbox に積みます: ${inboxChannelId} "${message.content}"`,
    );
    await appendInbox({
      channelId: inboxChannelId,
      groupName: match.group.name,
      sessionId,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
    }).catch(async (err) => {
      console.error("[handler] appendInbox 失敗:", err);
      await message.reply(
        "メッセージの受信に失敗しました。もう一度送ってください。",
      );
    });
  });
}
