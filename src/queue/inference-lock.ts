import type { ProviderConcurrency } from "../config/providers.js";

interface MutexState {
  locked: boolean;
  waiters: Array<() => void>;
}

const resourceMutexes = new Map<string, MutexState>();

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
      reject(new Error("inference lock aborted"));
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
function acquireResource(
  resource: string,
  signal?: AbortSignal,
): Promise<() => void> {
  const state = resourceMutexes.get(resource) ?? {
    locked: false,
    waiters: [],
  };
  resourceMutexes.set(resource, state);
  return acquire(
    state,
    () => {
      if (resourceMutexes.get(resource) === state) {
        resourceMutexes.delete(resource);
      }
    },
    signal,
  );
}

export async function acquireInferenceLock(
  resource: string,
  concurrency: ProviderConcurrency,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) throw new Error("inference lock aborted");
  if (concurrency === "serial") return acquireResource(resource, signal);
  return noopRelease;
}
