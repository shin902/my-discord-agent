import { Events, type Message, ThreadAutoArchiveDuration } from "discord.js";
import { findGroupByChannelId } from "../config/groups.js";
import { getQueueRepository } from "../queue/repository.js";
import type { QueueInput } from "../queue/types.js";

const enqueue = async (payload: QueueInput): Promise<void> => {
  await getQueueRepository().enqueue(payload);
};
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
    // スレッドの場合は親チャンネルIDで設定を検索する。
    // プロセス再起動直後などキャッシュ未保持のスレッドは、ゲートウェイの
    // MESSAGE_CREATE ペイロードだけから再構築されると parentId が欠落する
    // （discord.js が parent_id を含まない部分データでチャンネルを組み立てるため）。
    // その場合は REST でフル情報を取得して補う。
    let channel = message.channel;
    if (channel.isThread() && !channel.parentId) {
      channel = await channel.fetch().catch(() => channel);
    }
    const lookupId =
      channel.isThread() && channel.parentId
        ? channel.parentId
        : message.channelId;

    const match = await findGroupByChannelId(lookupId);
    if (!match) return;

    // bot/Webhookのメッセージは、許可リストに登録されたWebhook IDのみ処理する（feedcord等のRSS連携用）
    if (message.author.bot) {
      const allowedWebhookIds = match.channel.allowedWebhookIds ?? [];
      if (
        !message.webhookId ||
        !allowedWebhookIds.includes(message.webhookId)
      ) {
        return;
      }
    }

    let sessionId: string;
    let inboxChannelId = message.channelId;
    // レスポンス送信先チャンネルと元メッセージが同一チャンネルの場合のみ設定する。
    // auto-thread で新規スレッドを作る場合は inboxChannelId がスレッドに変わるため undefined のまま。
    let replyMessageId: string | undefined = message.id;

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
          // Discord API タイムアウト等でスレッドが作成済みの場合に回復を試みる
          // キャッシュ → APIから再取得 の順で確認
          const recovered =
            message.thread ??
            (
              await message.fetch().catch((e) => {
                console.error("[handler] メッセージ再取得失敗:", e);
                return null;
              })
            )?.thread ??
            null;
          if (recovered) {
            thread = recovered;
          } else {
            await message
              .reply("スレッドの作成に失敗しました。もう一度送ってください。")
              .catch((e) => console.error("[handler] reply 失敗:", e));
            return;
          }
        }
        sessionId = thread.id;
        inboxChannelId = thread.id;
        // 返信先はスレッドだが元メッセージは親チャンネルにあるため、
        // Discord のクロスチャンネル引用はできない
        replyMessageId = undefined;
      }
    } else if (match.channel.sessionMode === "email-mode") {
      // メールからcronで作成されたスレッドへの返信のみ処理。非スレッドは無視。
      if (!message.channel.isThread()) return;
      sessionId = message.channelId;
    } else {
      // Zod が loadGroups() 時点で未知の sessionMode を弾くため、ここには到達しない。
      // 新しいモードを groups.ts の enum に追加したときの対応漏れをコンパイルエラーで検知する。
      const _: never = match.channel.sessionMode;
      return;
    }

    const attachments =
      message.attachments.size > 0
        ? [...message.attachments.values()].map((a) => ({
            url: a.url,
            name: a.name,
            contentType: a.contentType,
            size: a.size,
          }))
        : undefined;

    console.log(
      `[handler] inbox に積みます: ${inboxChannelId} "${message.content}"`,
    );
    await enqueue({
      channelId: inboxChannelId,
      groupName: match.group.name,
      sessionId,
      messageId: replyMessageId,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
      attachments,
    }).catch(async (err: unknown) => {
      console.error("[handler] appendInbox 失敗:", err);
      await message.reply(
        "メッセージの受信に失敗しました。もう一度送ってください。",
      );
    });
  });
}
