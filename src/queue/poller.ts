import { ChannelType } from "discord.js";
import { type DiscordEvent, sendMessage } from "../agent/manager.js";
import { loadGroupConfig } from "../config/group-config.js";
import {
  type DispatchMode,
  loadDispatchMode,
} from "../config/poller-config.js";
import { client } from "../discord/client.js";
import { NonRetryableError } from "../utils/error.js";
import { splitMessage } from "../utils/splitMessage.js";
import { appendDeadLetter } from "./dead-letter.js";
import { type InboxMessage, prependInbox, shiftInbox } from "./inbox.js";

const POLL_MS = 1000;
const MAX_RETRIES = 10;
let running = false;

let globalChain = Promise.resolve();
const sessionChain = new Map<string, Promise<void>>();

export function dispatch(
  sessionId: string,
  fn: () => Promise<void>,
  mode: DispatchMode,
): void {
  const onError = (err: unknown) => {
    console.error("[poller] 予期せぬエラー (sessionId:", sessionId, "):", err);
  };
  if (mode === "serial") {
    globalChain = globalChain.then(fn).catch(onError);
  } else {
    const prev = sessionChain.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn).catch(onError);
    sessionChain.set(sessionId, next);
    next.finally(() => {
      if (sessionChain.get(sessionId) === next) sessionChain.delete(sessionId);
    });
  }
}

export function startPoller(): void {
  if (running) return;
  running = true;
  poll();
}

export function stopPoller(): void {
  running = false;
  globalChain = Promise.resolve();
  sessionChain.clear();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TYPING_INTERVAL_MS = 8_000;

function startTypingLoop(channelId: string): () => void {
  let cancelled = false;
  let cancelSleep: (() => void) | null = null;

  const loop = async () => {
    const channel =
      client.channels.cache.get(channelId) ??
      (await client.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) return;

    while (!cancelled) {
      try {
        // PartialGroupDMChannel は sendTyping を持たないため型アサションを使用
        await (channel as { sendTyping(): Promise<void> }).sendTyping();
      } catch {
        // typing indicator はベストエフォート
      }
      // sendTyping() の await 中に stopTyping() が呼ばれた場合はここで抜ける
      if (cancelled) break;
      await new Promise<void>((resolve) => {
        const id = setTimeout(resolve, TYPING_INTERVAL_MS);
        // stopTyping() が clearTimeout してすぐに resolve することでハンドルを即解放する
        cancelSleep = () => {
          clearTimeout(id);
          resolve();
        };
      });
      cancelSleep = null;
    }
  };

  void loop();
  return () => {
    cancelled = true;
    cancelSleep?.();
  };
}

async function sendDiscordEvent(
  channelId: string,
  event: DiscordEvent,
  replyMessageId?: string,
): Promise<void> {
  try {
    const channel =
      client.channels.cache.get(channelId) ??
      (await client.channels.fetch(channelId).catch(() => null));
    if (!channel?.isSendable()) return;

    let text: string;
    if (event.type === "tool_start") {
      if (event.args !== undefined) {
        const argsStr = JSON.stringify(event.args);
        const truncated =
          argsStr.length > 300 ? `${argsStr.slice(0, 300)}…` : argsStr;
        text = `🔧 \`${event.toolName}\` ${truncated}`;
      } else {
        text = `🔧 \`${event.toolName}\``;
      }
    } else {
      text = `⚠️ エラー: ${event.message}`;
    }

    const DISCORD_MAX = 2000;
    const content =
      text.length > DISCORD_MAX ? `${text.slice(0, DISCORD_MAX - 1)}…` : text;

    const shouldReply = event.type === "error" && replyMessageId;
    await channel.send(
      shouldReply
        ? {
            content,
            reply: {
              messageReference: replyMessageId,
              failIfNotExists: false,
            },
            allowedMentions: { repliedUser: true },
          }
        : content,
    );
  } catch (err) {
    console.error("[poller] Discord イベント送信エラー:", err);
  }
}

async function processCronThread(msg: InboxMessage): Promise<void> {
  if (!msg.cronJobId) {
    console.error(
      "[poller] cronThread フラグがあるが cronJobId が未設定:",
      msg,
    );
    await appendDeadLetter(msg);
    return;
  }
  // try の外で宣言: catch ブロックで cronThreadId として引き継ぐため
  let threadId: string | undefined;
  try {
    let sessionId: string;
    let threadSend: (content: string) => Promise<unknown>;
    if (msg.cronThreadId) {
      // リトライ: スレッドは作成済み。再作成せず既存スレッドをフェッチ
      threadId = msg.cronThreadId;
      sessionId = threadId;
      const fetched = await client.channels.fetch(threadId);
      if (!fetched?.isSendable()) {
        throw new NonRetryableError(
          `cron-thread: スレッド ${threadId} が見つかりません`,
        );
      }
      threadSend = (content) => fetched.send(content);
    } else {
      // 初回: チャンネルをフェッチしてスレッドを作成
      const channel = await client.channels.fetch(msg.channelId);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        throw new NonRetryableError(
          `cron-thread: チャンネル ${msg.channelId} はスレッドをサポートしていません`,
        );
      }
      const dateSuffix = new Date(msg.timestamp)
        .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })
        .slice(0, 16)
        .replace(" ", "-")
        .replace(":", "-");
      const suffix = `-${dateSuffix}`;
      const maxIdLen = 100 - "cron-".length - suffix.length;
      const truncatedId = msg.cronJobId.slice(0, maxIdLen);
      const thread = await channel.threads.create({
        name: `cron-${truncatedId}${suffix}`,
      });
      threadId = thread.id;
      sessionId = thread.id;
      threadSend = (content) => thread.send(content);
    }
    const response = await sendMessage(msg.groupName, sessionId, msg.content);
    if (response) {
      for (const chunk of splitMessage(response)) {
        await threadSend(chunk);
      }
    }
  } catch (err) {
    if (err instanceof NonRetryableError) {
      console.error("[poller] cron-thread 処理失敗（非リトライ可能）:", err);
      await appendDeadLetter(msg);
    } else {
      console.error(
        `[poller] cron-thread 処理失敗 (リトライ ${msg.retries}/${MAX_RETRIES}):`,
        err,
      );
      if (msg.retries + 1 < MAX_RETRIES) {
        // threadId がセット済み（スレッド作成後に失敗）なら次回リトライでスレッド再作成をスキップ
        await prependInbox({
          ...msg,
          retries: msg.retries + 1,
          cronThreadId: threadId,
        });
      } else {
        console.error(
          "[poller] cron-thread リトライ上限。dead-letter に移動:",
          msg.id,
        );
        await appendDeadLetter(msg);
      }
    }
  }
}

export async function processMessage(msg: InboxMessage): Promise<void> {
  if (msg.cronThread) {
    return processCronThread(msg);
  }

  const stopTyping = startTypingLoop(msg.channelId);
  let response: string;

  // グループ設定を先読みしてイベント通知と返信の両方で autoReply を参照できるようにする
  const groupConfig = await loadGroupConfig(msg.groupName).catch((err) => {
    console.error("[poller] グループ設定の読み込みエラー:", err);
    return null;
  });
  const replyMessageId =
    groupConfig?.autoReply && msg.messageId ? msg.messageId : undefined;

  try {
    try {
      response = await sendMessage(
        msg.groupName,
        msg.sessionId,
        msg.content,
        (event) => {
          void sendDiscordEvent(msg.channelId, event, replyMessageId);
        },
      );
    } catch (err) {
      if (err instanceof NonRetryableError) {
        console.error(`[poller] 処理失敗（非リトライ可能）:`, err);
        await appendDeadLetter(msg);
        return;
      }
      console.error(
        `[poller] 処理失敗 (リトライ ${msg.retries}/${MAX_RETRIES}):`,
        err,
      );
      if (msg.retries + 1 < MAX_RETRIES) {
        await prependInbox({ ...msg, retries: msg.retries + 1 });
      } else {
        console.error(
          "[poller] リトライ上限に達しました。dead-letter に移動:",
          msg.id,
        );
        await appendDeadLetter(msg);
      }
      const retryDelay = Math.min(1000 * 2 ** msg.retries, 60000);
      await sleep(retryDelay);
      return;
    }

    try {
      const channel = await client.channels.fetch(msg.channelId);
      if (channel?.isSendable() && response) {
        const chunks = splitMessage(response);
        const [firstChunk, ...restChunks] = chunks;
        if (firstChunk) {
          await channel.send(
            replyMessageId
              ? {
                  content: firstChunk,
                  reply: {
                    messageReference: replyMessageId,
                    failIfNotExists: false,
                  },
                  allowedMentions: { repliedUser: true },
                }
              : firstChunk,
          );
        }
        for (const chunk of restChunks) {
          await channel.send(chunk);
        }
      }
    } catch (err) {
      console.error(`[poller] Discord送信エラー:`, err);
    }
  } finally {
    stopTyping();
  }
}

async function poll(): Promise<void> {
  const mode = await loadDispatchMode();
  while (running) {
    if (client.isReady()) {
      const msg = await shiftInbox();
      if (msg) {
        // ノンブロッキングで dispatch → 即次のメッセージを取りに行く
        dispatch(msg.sessionId, () => processMessage(msg), mode);
        continue;
      }
    }
    await sleep(POLL_MS);
  }
}
