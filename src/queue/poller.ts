import { client } from '../discord/client.js';
import { shiftInbox, prependInbox, type InboxMessage } from './inbox.js';
import { appendDeadLetter } from './dead-letter.js';
import { sendMessage } from '../agent/manager.js';
import { splitMessage } from '../utils/splitMessage.js';

const POLL_MS = 1000;
const MAX_RETRIES = 10;
let running = false;

// チャンネルごとに処理を直列化する Promise チェーン。
// 異なるチャンネルは並列実行、同一チャンネルは順番通りに処理される。
const channelChain = new Map<string, Promise<void>>();

function dispatchWithChannelLock(channelId: string, fn: () => Promise<void>): void {
  const prev = channelChain.get(channelId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  channelChain.set(channelId, next);
  next.finally(() => {
    if (channelChain.get(channelId) === next) channelChain.delete(channelId);
  });
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

async function processMessage(msg: InboxMessage): Promise<void> {
  let response: string;

  try {
    response = await sendMessage(msg.groupName, msg.channelId, msg.content);
  } catch (err) {
    console.error(`[poller] 処理失敗 (リトライ ${msg.retries}/${MAX_RETRIES}):`, err);
    if (msg.retries + 1 < MAX_RETRIES) {
      await prependInbox({ ...msg, retries: msg.retries + 1 });
    } else {
      console.error('[poller] リトライ上限に達しました。dead-letter に移動:', msg.id);
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
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
  } catch (err) {
    console.error(`[poller] Discord送信エラー:`, err);
  }
}

async function poll(): Promise<void> {
  while (running) {
    if (client.isReady()) {
      const msg = await shiftInbox();
      if (msg) {
        // ノンブロッキングで dispatch → 即次のメッセージを取りに行く
        dispatchWithChannelLock(msg.channelId, () => processMessage(msg));
        continue;
      }
    }
    await sleep(POLL_MS);
  }
}
