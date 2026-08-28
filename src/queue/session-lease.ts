import { randomUUID } from "node:crypto";
import type { BotTaskSessionLease, QueueRepository } from "./repository.js";

const SESSION_LEASE_MS = 60_000;
const SESSION_LEASE_RENEW_MS = 20_000;
const SESSION_LEASE_RETRY_MS = 100;

function waitForRetry(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Bot Task Session lease aborted"));
    const timer = setTimeout(() => finish(), SESSION_LEASE_RETRY_MS);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Serialize all Bot Task Session executions through the runtime database.
 * The lease is recoverable after a crashed host and renewed for long runs.
 */
export async function withBotTaskSessionLease<T>(
  repository: QueueRepository,
  sessionId: string,
  fn: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const ownerId = `bot-session-${randomUUID()}`;
  let lease: BotTaskSessionLease | undefined;
  while (lease === undefined) {
    if (signal?.aborted) throw new Error("Bot Task Session lease aborted");
    lease = repository.tryAcquireBotTaskSessionLease(
      sessionId,
      ownerId,
      SESSION_LEASE_MS,
    );
    if (lease === undefined) await waitForRetry(signal);
  }

  const runController = new AbortController();
  const forwardAbort = () => runController.abort(signal?.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const renewal = setInterval(() => {
    try {
      if (
        !repository.renewBotTaskSessionLease(
          lease as BotTaskSessionLease,
          SESSION_LEASE_MS,
        )
      ) {
        runController.abort(new Error("Bot Task Session lease expired"));
      }
    } catch (error) {
      runController.abort(error);
    }
  }, SESSION_LEASE_RENEW_MS);
  renewal.unref?.();

  try {
    return await fn(runController.signal);
  } finally {
    clearInterval(renewal);
    signal?.removeEventListener("abort", forwardAbort);
    repository.releaseBotTaskSessionLease(lease);
  }
}
