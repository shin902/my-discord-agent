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
import { sendMessage } from '../agent/manager.js';

const POLL_MS = 1000;
const MAX_RETRIES = 10;
let running = false;

export function startPoller(): void {
  if (running) return;
  running = true;
  poll();
}

export function stopPoller(): void {
  running = false;
}

async function poll(): Promise<void> {
  if (!running) return;

  // client が未接続の間はスキップ（起動直後など）
  if (client.isReady()) {
    try {
      const msg = await shiftInbox();
      if (msg) {
        try {
          const response = await sendMessage(msg.channelId, msg.content);
          const channel = await client.channels.fetch(msg.channelId);
          if (channel?.isSendable()) {
            await channel.send(response);
          }
        } catch (err) {
          console.error(`[poller] 処理失敗 (試行 ${msg.retries + 1}/${MAX_RETRIES}):`, err);
          if (msg.retries + 1 < MAX_RETRIES) {
            // リトライ: retries をインクリメントして先頭に戻す
            await prependInbox({ ...msg, retries: msg.retries + 1 });
          } else {
            console.error('[poller] リトライ上限に達しました。メッセージを破棄:', msg.id);
          }
        }
      }
    } catch (err) {
      console.error('[poller] キュー読み取りエラー:', err);
    }
  }

  setTimeout(poll, POLL_MS);
}
