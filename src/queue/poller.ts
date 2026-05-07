/**
 * ポーラー — 1秒ごとに inbox を確認し、処理から Discord 送信まで一気に行う。
 *
 * フロー: shiftInbox() → sendMessage() → channel.send()
 *
 * 失敗時は retries をインクリメントして先頭に戻す。
 * MAX_RETRIES を超えたらメッセージを破棄する。
 */
import { client } from '../discord/client.js';
import { shiftInbox, prependInbox } from './inbox.js';
import { appendDeadLetter } from './dead-letter.js';
import { sendMessage } from '../agent/manager.js';

const POLL_MS = 1000;
const MAX_RETRIES = 10;
const DISCORD_MAX_LENGTH = 2000;
let running = false;

/**
 * 改行を優先して Discord の文字数制限内に収めるようにメッセージを分割する。
 * 2000文字以内で最後の改行を探し、そこで分割。改行がなければ強制分割。
 */
function splitMessage(text: string, maxLength: number = DISCORD_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf('\n', maxLength);
    if (splitIndex < 1) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    // 残った先頭の改行を消す
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export function startPoller(): void {
  if (running) return;
  running = true;
  poll();
}

export function stopPoller(): void {
  running = false;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function poll(): Promise<void> {
  while (running) {
    // client が未接続の間はスキップ（起動直後など）
    if (client.isReady()) {
      const msg = await shiftInbox();

      if (msg) {
        let response: string;

        try {
          response = await sendMessage(msg.channelId, msg.content);
        } catch (err) {
          console.error(`[poller] 処理失敗 (リトライ ${msg.retries}/${MAX_RETRIES}):`, err);
          if (msg.retries + 1 < MAX_RETRIES) {
            // リトライ: retries をインクリメントして先頭に戻す
            await prependInbox({ ...msg, retries: msg.retries + 1 });
          } else {
            console.error('[poller] リトライ上限に達しました。dead-letter に移動:', msg.id);
            await appendDeadLetter(msg);
          }
          const retryDelay = Math.min(1000 * 2 ** msg.retries, 60000);
          await sleep(retryDelay);
          continue;
        }

        try {
          const channel = await client.channels.fetch(msg.channelId);
          // テキストチャネルなど送信可能なチャンネルかつ、エージェントが何かしらのレスポンスを返した場合のみ送信（nullじゃだめ。空文字とかもだめ）
          if (channel?.isSendable() && response) {
            const chunks = splitMessage(response);
            for (const chunk of chunks) {
              await channel.send(chunk);
            }
          }
        } catch (err) {
          console.error(`[poller] Discord送信エラー:`, err);
        }
      }
    }
    await sleep(POLL_MS);
  }
}