import type { ProviderConcurrency } from "../config/providers.js";

type Release = () => void;

interface SemaphoreState {
  active: number;
  limit: number;
  waiters: Array<() => void>;
}

const resources = new Map<string, SemaphoreState>();
const noopRelease = () => {};

function acquire(
  state: SemaphoreState,
  signal?: AbortSignal,
  onIdle?: () => void,
): Promise<Release> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("inference lock aborted"));
      return;
    }
    let settled = false;
    const abort = () => {
      if (settled) return;
      settled = true;
      const index = state.waiters.indexOf(grant);
      if (index >= 0) state.waiters.splice(index, 1);
      signal?.removeEventListener("abort", abort);
      reject(new Error("inference lock aborted"));
    };
    const grant = () => {
      if (signal?.aborted) {
        abort();
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      state.active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        state.active--;
        // Reserve the freed slot synchronously, before a new caller can take it.
        while (state.active < state.limit && state.waiters.length > 0) {
          state.waiters.shift()?.();
        }
        if (state.active === 0 && state.waiters.length === 0) onIdle?.();
      });
    };
    if (state.active < state.limit) grant();
    else {
      state.waiters.push(grant);
      signal?.addEventListener("abort", abort, { once: true });
    }
  });
}

/** Host-only scope for lending one parent's slot to one child at a time. */
export interface HeldInferenceResource {
  readonly resource: string;
  readonly signal: AbortSignal;
  /** Cancel borrowers and wait for their executions to release the slot. */
  close(): Promise<void>;
  borrow(signal?: AbortSignal): Promise<Release>;
}

export function createHeldInferenceResource(
  resource: string,
): HeldInferenceResource {
  const state: SemaphoreState = { active: 0, limit: 1, waiters: [] };
  const controller = new AbortController();
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  return {
    resource,
    signal: controller.signal,
    borrow: (signal) =>
      acquire(
        state,
        signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        () => {
          if (controller.signal.aborted) resolveDrained();
        },
      ),
    close: () => {
      controller.abort();
      if (state.active === 0) resolveDrained();
      return drained;
    },
  };
}

export async function acquireInferenceLock(
  resource: string,
  concurrency: ProviderConcurrency,
  signal?: AbortSignal,
): Promise<Release> {
  if (signal?.aborted) throw new Error("inference lock aborted");
  if (concurrency === "parallel") return noopRelease;
  const limit = concurrency === "serial" ? 1 : concurrency;
  const state = resources.get(resource) ?? { active: 0, limit, waiters: [] };
  if (state.limit !== limit) {
    throw new Error(`inference resource limit mismatch: ${resource}`);
  }
  resources.set(resource, state);
  return acquire(state, signal, () => {
    if (resources.get(resource) === state) resources.delete(resource);
  });
}
