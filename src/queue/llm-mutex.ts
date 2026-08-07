import type { ProviderConcurrency } from "../config/providers.js";

interface MutexState {
  locked: boolean;
  waiters: Array<() => void>;
}

// serial provider ごとに独立したミューテックスを持つ。
// serial provider A と serial provider B は互いをブロックしない。
const providerMutexes = new Map<string, MutexState>();

const noopRelease = () => {};

function acquire(
  state: MutexState,
  onIdle?: () => void,
  signal?: AbortSignal,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    let queued = false;
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      if (queued) {
        const index = state.waiters.indexOf(tryAcquire);
        if (index >= 0) state.waiters.splice(index, 1);
      }
      reject(new Error("provider lock aborted"));
    };
    const tryAcquire = () => {
      queued = false;
      if (settled || signal?.aborted) {
        abort();
        return;
      }
      state.locked = true;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        const next = state.waiters.shift();
        if (next) next();
        else {
          state.locked = false;
          onIdle?.();
        }
      });
    };
    if (!state.locked) {
      tryAcquire();
      return;
    }
    queued = true;
    state.waiters.push(tryAcquire);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function acquireProvider(
  provider: string,
  signal?: AbortSignal,
): Promise<() => void> {
  const state = providerMutexes.get(provider) ?? {
    locked: false,
    waiters: [],
  };
  providerMutexes.set(provider, state);
  return acquire(
    state,
    () => {
      if (providerMutexes.get(provider) === state) {
        providerMutexes.delete(provider);
      }
    },
    signal,
  );
}

/**
 * LLM 呼び出し（sendMessage()）の前後で取得するロック。
 * - provider concurrency が serial: provider 単位のミューテックスで待機
 * - provider concurrency が parallel: ロックなし
 */
export async function acquireLlmLock(
  provider: string,
  concurrency: ProviderConcurrency,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) throw new Error("provider lock aborted");
  if (concurrency === "serial") return acquireProvider(provider, signal);
  return noopRelease;
}
