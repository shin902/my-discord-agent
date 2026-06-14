import type { DispatchMode } from "../config/poller-config.js";

// グローバルミューテックス（concurrency=1）。serial モードで sendMessage() の同時実行を 1 つに絞る。
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
 * - serial モード: グローバルなミューテックス（concurrency=1）で待機し、release 関数を返す
 * - parallel-session モード: ロックなし。即座に no-op の release を返す
 */
export async function acquireLlmLock(mode: DispatchMode): Promise<() => void> {
  if (mode !== "serial") {
    return noopRelease;
  }
  return acquire();
}
