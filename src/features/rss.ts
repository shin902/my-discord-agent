import { z } from "zod";
import { enqueueCronInbox } from "../cron/enqueue.js";
import type { CronContext } from "../cron/runner.js";
import {
  getQueueRepository,
  type QueueRepository,
} from "../queue/repository.js";
import type { SourceHandlers } from "../queue/source-handlers.js";
import type { InboxMessage } from "../queue/types.js";
import {
  listDispatchClaims,
  markArticlesRead,
  releaseDispatchArticles,
  tryOpenRssDb,
} from "../rss/store.js";

export type RssDispatchResolution = "completed" | "dead_letter";

const rssInput = z.object({
  dispatchId: z.string().min(1),
  statePath: z.string().optional(),
  dispatchJobId: z.string().optional(),
});
export type RssSourceInput = z.infer<typeof rssInput>;

export function discoverRssStatePaths(repo: QueueRepository): string[] {
  const paths = new Set<string>();
  for (const value of repo.listSourceInputs("rss")) {
    const parsed = rssInput.safeParse(value);
    if (parsed.success && parsed.data.statePath)
      paths.add(parsed.data.statePath);
  }
  return [...paths];
}

export async function enqueueRssDispatch(
  ctx: CronContext,
  content: string,
  dispatchId: string,
  dispatchJobId: string,
  statePath?: string,
): Promise<void> {
  await enqueueCronInbox(
    {
      ...ctx,
      idempotencyKey: dispatchJobId,
      feature: {
        kind: "rss",
        input: rssInput.parse({ dispatchId, dispatchJobId, statePath }),
      },
    },
    content,
  );
}

export function registerRssSource(
  handlers: SourceHandlers,
  repo: QueueRepository,
  settle: typeof settleRssDispatch = settleRssDispatch,
): void {
  handlers.register("rss", rssInput, {
    continueAfterFailedChunk: true,
    terminalOnAgentFailure: true,
    suppressed(input) {
      try {
        const settled = settle(
          input.statePath,
          input.dispatchId,
          input.dispatchJobId,
          "completed",
        );
        if (settled !== 1)
          throw new Error(
            "RSS dispatch claim was not found or could not be opened",
          );
      } catch (error) {
        try {
          if (
            settle(
              input.statePath,
              input.dispatchId,
              input.dispatchJobId,
              "dead_letter",
            ) !== 1
          )
            throw new Error(
              "RSS dispatch claim was not found or could not be opened",
            );
        } catch (releaseError) {
          console.error(
            "[rss] suppressed dispatch release failed:",
            releaseError,
          );
        }
        throw error;
      }
    },
    terminal(input, message: InboxMessage) {
      const job = repo.get(message.id);
      if (!job || (job.status !== "completed" && job.status !== "dead_letter"))
        return;
      // Only successful jobs with a Discord delivery wait for the worker.
      if (
        job.status === "completed" &&
        ["direct", "new-thread", "item-thread"].includes(
          message.cronDeliveryMode ?? "",
        )
      )
        return;
      settle(
        input.statePath,
        input.dispatchId,
        input.dispatchJobId,
        job.status,
      );
    },
    delivery(input, _row, statuses) {
      if (statuses.every((status) => status === "sent")) {
        settle(
          input.statePath,
          input.dispatchId,
          input.dispatchJobId,
          "completed",
        );
      } else if (
        statuses.some((status) => status === "failed" || status === "ambiguous")
      ) {
        settle(
          input.statePath,
          input.dispatchId,
          input.dispatchJobId,
          "dead_letter",
        );
      }
    },
  });
}

/**
 * Settle one RSS dispatch after its associated queue job reaches a terminal
 * state. This is deliberately targeted: a live queue transition must not
 * release another dispatch that is still between claim and queue admission.
 */
export function settleRssDispatch(
  rssDbPath: string | undefined,
  dispatchId: string,
  dispatchJobId: string | undefined,
  resolution: RssDispatchResolution,
): number {
  const result = tryOpenRssDb(rssDbPath);
  if (!result.ok) return 0;
  try {
    const claim = listDispatchClaims(result.db).find(
      (candidate) =>
        candidate.dispatchId === dispatchId &&
        (dispatchJobId === undefined ||
          candidate.dispatchJobId === dispatchJobId),
    );
    if (!claim) return 0;
    if (resolution === "completed") {
      markArticlesRead(result.db, claim.articleIds);
    } else {
      releaseDispatchArticles(result.db, claim.dispatchId, claim.articleIds);
    }
    return 1;
  } finally {
    result.db.close();
  }
}

/**
 * Resolve the two crash windows between RSS claiming, queue insertion, and read marking.
 * A job with terminal deliveries, or an explicit suppressed success, makes its
 * articles read; a missing/failed job releases its claim.
 */
export function reconcileRssDispatches(
  repo: QueueRepository = getQueueRepository(),
  rssDbPaths?: string | readonly string[],
): number {
  const configured = typeof rssDbPaths === "string" ? [rssDbPaths] : rssDbPaths;
  // Caller-supplied paths are authoritative. Standalone reconciliation only
  // scans persisted RSS inputs, never another feature's private payload.
  const discovered =
    configured === undefined ? discoverRssStatePaths(repo) : configured;
  const paths = new Set<string | undefined>([undefined, ...discovered]);
  let resolved = 0;
  for (const rssDbPath of paths) {
    const result = tryOpenRssDb(rssDbPath);
    if (!result.ok) continue; // Skips the default/missing DB best-effort.
    const db = result.db;
    try {
      for (const claim of listDispatchClaims(db)) {
        const job = repo.findByIdempotencyKey(claim.dispatchJobId);
        const record = repo.getIdempotencyRecord(claim.dispatchJobId);
        const deliveries = job
          ? repo
              .listDeliveries()
              .filter((delivery) => delivery.jobId === job.id)
          : [];
        const completed =
          job?.status === "completed" || record?.status === "completed";
        const allSent =
          deliveries.length > 0 &&
          deliveries.every((delivery) => delivery.status === "sent");
        const allTerminal =
          deliveries.length > 0 &&
          deliveries.every((delivery) =>
            ["sent", "failed", "ambiguous"].includes(delivery.status),
          );
        const suppressedSuccess =
          job?.status === "completed" &&
          job.terminalState === "succeeded" &&
          job.succeeded &&
          job.deliverySuppressed &&
          deliveries.length === 0;
        if ((completed && allSent) || suppressedSuccess) {
          markArticlesRead(db, claim.articleIds);
          resolved++;
        } else if (
          job?.status === "dead_letter" ||
          record?.status === "dead_letter" ||
          !record ||
          (completed && allTerminal)
        ) {
          releaseDispatchArticles(db, claim.dispatchId, claim.articleIds);
          resolved++;
        }
      }
    } catch {
      // A malformed RSS schema must not prevent unrelated startup paths.
    } finally {
      db.close();
    }
  }
  return resolved;
}
