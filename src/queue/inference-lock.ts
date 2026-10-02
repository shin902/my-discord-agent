import type { ProviderConcurrency } from "../config/providers.js";

type Release = () => void;

interface SemaphoreState {
  active: number;
  limit: number;
  waiters: Array<() => void>;
}

export interface InferenceOwner {
  resource: string;
  provider: string;
}

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
      if (state.active === 0 && state.waiters.length === 0) onIdle?.();
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
  readonly provider: string;
  readonly signal: AbortSignal;
  /** Cancel borrowers and wait for their executions to release the slot. */
  close(): Promise<void>;
  borrow(signal?: AbortSignal): Promise<Release>;
}

export function createHeldInferenceResource(
  target: InferenceOwner,
): HeldInferenceResource {
  const { resource, provider } = target;
  const state: SemaphoreState = { active: 0, limit: 1, waiters: [] };
  const controller = new AbortController();
  let resolveDrained!: () => void;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });
  return {
    resource,
    provider,
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

/** Dedicated unlimited providers cannot block; explicit shared resources can. */
export function requiresInferenceOwnership(
  target: InferenceOwner & { concurrency: ProviderConcurrency },
): boolean {
  return (
    target.concurrency !== "parallel" || target.resource.startsWith("resource:")
  );
}

interface ResourceWaiter {
  provider: string;
  limit: number;
  grant(): void;
}
interface OwnedResource {
  owner?: string;
  active: number;
  limit: number;
  waiters: ResourceWaiter[];
}
const ownedResources = new Map<string, OwnedResource>();

export async function acquireInferenceLock(
  target: InferenceOwner,
  concurrency: ProviderConcurrency,
  signal?: AbortSignal,
): Promise<Release> {
  if (signal?.aborted) throw new Error("inference lock aborted");
  const { resource, provider } = target;
  const limit =
    concurrency === "parallel"
      ? Infinity
      : concurrency === "serial"
        ? 1
        : concurrency;
  const state = ownedResources.get(resource) ?? {
    active: 0,
    limit,
    waiters: [],
  };
  if (
    (state.owner === provider && state.limit !== limit) ||
    state.waiters.some((w) => w.provider === provider && w.limit !== limit)
  ) {
    throw new Error(`inference resource limit mismatch: ${resource}`);
  }
  ownedResources.set(resource, state);
  const pump = () => {
    // Skip cancelled grants without recursion, then reserve slots synchronously.
    do {
      if (
        state.active === 0 &&
        !state.waiters.some((waiter) => waiter.provider === state.owner)
      ) {
        state.owner = state.waiters[0]?.provider;
        state.limit = state.waiters[0]?.limit ?? limit;
      }
      while (state.active < state.limit) {
        const index = state.waiters.findIndex(
          (waiter) => waiter.provider === state.owner,
        );
        if (index < 0) break;
        state.waiters.splice(index, 1)[0].grant();
      }
    } while (state.active === 0 && state.waiters.length > 0);
    if (state.active === 0 && state.waiters.length === 0)
      ownedResources.delete(resource);
  };
  return new Promise<Release>((resolve, reject) => {
    const abort = () => {
      const index = state.waiters.indexOf(waiter);
      if (index < 0) return;
      state.waiters.splice(index, 1);
      signal?.removeEventListener("abort", abort);
      reject(new Error("inference lock aborted"));
      pump();
    };
    const waiter: ResourceWaiter = {
      provider,
      limit,
      grant: () => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) {
          reject(new Error("inference lock aborted"));
          return;
        }
        state.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          state.active--;
          pump();
        });
      },
    };
    state.waiters.push(waiter);
    signal?.addEventListener("abort", abort, { once: true });
    pump();
  });
}
