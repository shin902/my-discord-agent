import type { BotTaskSessionAdmission, QueueRepository } from "./repository.js";

const SESSION_ADMISSION_RETRY_MS = 100;

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
    const abort = () => finish(new Error("Bot Task Session admission aborted"));
    const timer = setTimeout(() => finish(), SESSION_ADMISSION_RETRY_MS);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Serialize direct Bot invocations through the ordered admission ticket.
 * The ticket remains active until the execution callback has settled.
 */
export interface BotTaskSessionAdmissionOptions {
  /** Fail instead of waiting when a predecessor would require the held lock. */
  failIfBlocked?: boolean;
}

export async function withBotTaskSessionAdmission<T>(
  repository: QueueRepository,
  admission: BotTaskSessionAdmission,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  options: BotTaskSessionAdmissionOptions = {},
): Promise<T> {
  let admitted = false;
  try {
    if (options.failIfBlocked) {
      const result = repository.tryAdmitBotTaskSessionAdmission(admission);
      if (result === "blocked")
        throw new Error(
          "先行するBot Task Session処理が親のprovider lockを待つため、同期Bot呼び出しを開始できません",
        );
      if (result === "unavailable")
        throw new Error("Bot Task Session admissionを開始できません");
      admitted = true;
    } else {
      while (!admitted) {
        if (signal?.aborted)
          throw new Error("Bot Task Session admission aborted");
        admitted = repository.admitBotTaskSessionAdmission(admission);
        if (!admitted) await waitForRetry(signal);
      }
    }
    return await fn();
  } finally {
    if (admitted) repository.completeBotTaskSessionAdmission(admission);
    else repository.cancelBotTaskSessionAdmission(admission);
  }
}
