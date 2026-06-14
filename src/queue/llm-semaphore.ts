import type { DispatchMode } from "../config/poller-config.js";

// concurrency=1 のグローバルセマフォ。serial モードで sendMessage() の同時実行を 1 つに絞る。
let locked = false;
const waiters: Array<() => void> = [];

const noopRelease = () => {};

function acquire(): Promise<() => void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      locked = true;
      resolve(release);
    };
    if (!locked) {
      tryAcquire();
      return;
    }
    waiters.push(tryAcquire);
  });
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();
  } else {
    locked = false;
  }
}

/**
 * LLM 呼び出し（sendMessage()）の前後で取得するロック。
 * - serial モード: グローバルな concurrency=1 セマフォで待機し、release 関数を返す
 * - parallel-session モード: セマフォなし。即座に no-op の release を返す
 */
export async function acquireLlmLock(
  mode: DispatchMode,
  _sessionId: string,
): Promise<() => void> {
  if (mode !== "serial") {
    return noopRelease;
  }
  return acquire();
}

/** テスト専用: セマフォの内部状態をリセットする */
export function _resetLlmSemaphore(): void {
  locked = false;
  waiters.length = 0;
}
