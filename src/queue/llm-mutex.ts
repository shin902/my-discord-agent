import type { ProviderConcurrency } from "../config/providers.js";

interface MutexState {
  locked: boolean;
  waiters: Array<() => void>;
}

// serial provider ごとに独立したミューテックスを持つ。
// serial provider A と serial provider B は互いをブロックしない。
const providerMutexes = new Map<string, MutexState>();

const noopRelease = () => {};

function acquire(state: MutexState, onIdle?: () => void): Promise<() => void> {
  return new Promise((resolve) => {
    const tryAcquire = () => {
      state.locked = true;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        const next = state.waiters.shift();
        if (next) {
          next();
        } else {
          state.locked = false;
          onIdle?.();
        }
      });
    };
    if (!state.locked) {
      tryAcquire();
      return;
    }
    state.waiters.push(tryAcquire);
  });
}

function acquireProvider(provider: string): Promise<() => void> {
  const state = providerMutexes.get(provider) ?? {
    locked: false,
    waiters: [],
  };
  providerMutexes.set(provider, state);
  return acquire(state, () => {
    if (providerMutexes.get(provider) === state) {
      providerMutexes.delete(provider);
    }
  });
}

/**
 * LLM 呼び出し（sendMessage()）の前後で取得するロック。
 * - provider concurrency が serial: provider 単位のミューテックスで待機
 * - provider concurrency が parallel: ロックなし
 */
export async function acquireLlmLock(
  provider: string,
  concurrency: ProviderConcurrency,
): Promise<() => void> {
  if (concurrency === "serial") return acquireProvider(provider);
  return noopRelease;
}
