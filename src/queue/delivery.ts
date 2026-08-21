import { randomUUID } from "node:crypto";
import type { Client } from "discord.js";
import {
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";
import { settleRssDispatch } from "./reconciliation.js";

function discordClientsReady(): boolean {
  return [...getDiscordClients().values()].some((value) => value.isReady());
}

async function resolveDiscordClient(groupName: string) {
  return getDiscordClientForGroupName(groupName);
}

import type {
  DeliveryClaim,
  DeliveryRow,
  QueueRepository,
} from "./repository.js";

export type DeliveryErrorKind = "retryable" | "non-retryable" | "unknown";
export class DeliveryError extends Error {
  constructor(
    public readonly kind: DeliveryErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}
export interface DeliverySendContext {
  persistCronThread?: (cronThreadId: string) => Promise<void> | void;
}
export interface DeliveryAdapter {
  send(
    row: DeliveryRow,
    context?: DeliverySendContext,
  ): Promise<{ externalMessageId: string; cronThreadId?: string }>;
}
function statusCode(error: unknown): number | undefined {
  const value = error as { status?: unknown; statusCode?: unknown };
  const code = value?.status ?? value?.statusCode;
  return typeof code === "number" ? code : undefined;
}
export function classifyDiscordError(error: unknown): DeliveryErrorKind {
  const status = statusCode(error);
  if (status !== undefined)
    return status === 429 || status >= 500 ? "retryable" : "non-retryable";
  if (
    error instanceof TypeError ||
    (error instanceof Error &&
      /timeout|network|econn|socket|fetch/i.test(error.message))
  )
    return "retryable";
  return "unknown";
}
interface DeliveryPayload {
  content?: string;
  groupName?: string;
  destinationType?: string;
  destinationId?: string;
  replyMessageId?: string;
  // 省略時はメンション通知を許可しない。
  allowMention?: boolean;
  cronJobId?: string;
  cronThreadId?: string;
  cronPlaceholderMessageId?: string;
}
type DeliveryTarget = {
  id?: unknown;
  isSendable?: () => boolean;
  send: (payload: unknown) => Promise<{ id?: unknown }>;
  edit?: (payload: unknown) => Promise<unknown>;
  messages?: { fetch: (id: string) => Promise<DeliveryTarget> };
  threads?: { create: (options: { name: string }) => Promise<DeliveryTarget> };
};
export class DiscordDeliveryAdapter implements DeliveryAdapter {
  async send(
    row: DeliveryRow,
    context: DeliverySendContext = {},
  ): Promise<{ externalMessageId: string; cronThreadId?: string }> {
    const payload = JSON.parse(row.payloadJson ?? "{}") as DeliveryPayload;
    // Discord's create/send calls are mutations whose response can be lost
    // after the server has applied the change. Transport/unknown failures
    // after either call therefore must not be retried automatically.
    let mutationAttempted = false;
    try {
      const destinationId = payload.destinationId ?? row.destinationId;
      if (!destinationId)
        throw new DeliveryError(
          "non-retryable",
          "delivery has no destinationId",
        );
      if (!payload.groupName)
        throw new DeliveryError("non-retryable", "delivery has no groupName");
      let client: Client;
      try {
        client = await resolveDiscordClient(payload.groupName);
      } catch (error) {
        throw new DeliveryError(
          "non-retryable",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      if (typeof client.isReady === "function" && !client.isReady())
        throw new DeliveryError("retryable", "Discord client is not ready");
      let threadId = row.cronThreadId ?? payload.cronThreadId;
      let target: DeliveryTarget | undefined;
      if (
        payload.destinationType === "new-thread" ||
        row.destinationType === "new-thread"
      ) {
        if (threadId) {
          target = (await client.channels.fetch(
            threadId,
          )) as unknown as DeliveryTarget;
        } else {
          const channel = (await client.channels.fetch(
            destinationId,
          )) as unknown as DeliveryTarget | null;
          if (!channel)
            throw new DeliveryError(
              "retryable",
              "destination channel is unavailable",
            );
          if (typeof channel.threads?.create !== "function")
            throw new DeliveryError(
              "non-retryable",
              "destination does not support threads",
            );
          mutationAttempted = true;
          target = await channel.threads.create({
            name: `cron-${String(payload.cronJobId ?? row.jobId).slice(0, 90)}`,
          });
          threadId = String(target.id);
          try {
            await context.persistCronThread?.(threadId);
          } catch (error) {
            throw new DeliveryError(
              "unknown",
              `failed to persist Discord thread ${threadId}`,
              error,
            );
          }
        }
      } else {
        target = (client.channels.cache.get(destinationId) ??
          (await client.channels.fetch(
            destinationId,
          ))) as unknown as DeliveryTarget;
      }
      if (!target)
        throw new DeliveryError(
          "retryable",
          "destination channel is unavailable",
        );
      if (typeof target.isSendable !== "function" || !target.isSendable())
        throw new DeliveryError("non-retryable", "destination is not sendable");
      const content = String(payload.content ?? "");
      const allowMention = payload.allowMention === true;
      const allowedMentions = allowMention
        ? { repliedUser: true }
        : { parse: [], repliedUser: false };
      // Cron item threads reserve a visible placeholder before the LLM starts.
      // Replace that message with the first response chunk rather than adding a
      // second parent message. Remaining chunks are posted in the same thread.
      if (payload.cronPlaceholderMessageId && target !== undefined) {
        const channel = (await client.channels.fetch(
          destinationId,
        )) as unknown as DeliveryTarget | null;
        const placeholder = await channel?.messages?.fetch(
          payload.cronPlaceholderMessageId,
        );
        if (!placeholder?.edit) {
          throw new DeliveryError(
            "non-retryable",
            "cron placeholder cannot be fetched or edited",
          );
        }
        mutationAttempted = true;
        try {
          await placeholder.edit({ content, allowedMentions });
        } catch (error) {
          // Editing the same placeholder is idempotent, so transient failures
          // are safe to retry. Permanent Discord responses remain failed.
          const status = statusCode(error);
          const kind = classifyDiscordError(error);
          const editKind =
            status === 403 || status === 404 || kind === "non-retryable"
              ? "non-retryable"
              : "retryable";
          throw new DeliveryError(
            editKind,
            "cron placeholder edit failed",
            error,
          );
        }
      }
      const reply = payload.replyMessageId && !threadId;
      mutationAttempted = true;
      const value = payload.cronPlaceholderMessageId
        ? { id: payload.cronPlaceholderMessageId }
        : reply
          ? await target.send({
              content,
              reply: {
                messageReference: payload.replyMessageId,
                failIfNotExists: false,
              },
              // allowMention=true は従来の送信形式を維持する。
              allowedMentions,
            })
          : await target.send(
              allowMention ? content : { content, allowedMentions },
            );
      return {
        externalMessageId: String(value?.id ?? randomUUID()),
        ...(threadId ? { cronThreadId: threadId } : {}),
      };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      const kind = classifyDiscordError(error);
      const status = statusCode(error);
      // After create/send starts, a 5xx response does not prove that Discord
      // rejected the mutation. Treat it like a lost transport response rather
      // than retrying and potentially duplicating a thread or message. A 429 is
      // safe to retry because it explicitly reports rate-limit rejection.
      const postMutationAmbiguous =
        mutationAttempted &&
        (status !== undefined
          ? status >= 500
          : kind === "retryable" || kind === "unknown");
      const effectiveKind = postMutationAmbiguous
        ? "unknown"
        : kind === "unknown"
          ? "retryable"
          : kind;
      throw new DeliveryError(
        effectiveKind,
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }
}
export interface DeliveryWorkerOptions {
  pollMs?: number;
  leaseMs?: number;
  retryDelayMs?: number;
  workerId?: string;
  ready?: () => boolean;
}
export class DeliveryWorker {
  private running = false;
  private readonly workerId: string;
  constructor(
    private readonly repository: QueueRepository,
    private readonly adapter: DeliveryAdapter = new DiscordDeliveryAdapter(),
    private readonly options: DeliveryWorkerOptions = {},
  ) {
    this.workerId = options.workerId ?? "delivery-single-host";
  }
  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }
  stop(): void {
    this.running = false;
  }
  async runOnce(at = new Date()): Promise<boolean> {
    if (this.options.ready && !this.options.ready()) return false;
    if (
      !this.options.ready &&
      this.adapter instanceof DiscordDeliveryAdapter &&
      !discordClientsReady()
    )
      return false;
    const claim = this.repository.claimDelivery(
      this.workerId,
      this.options.leaseMs ?? 60_000,
      at,
    );
    if (!claim) return false;
    await this.process(claim);
    return true;
  }
  private async process(claim: DeliveryClaim): Promise<void> {
    try {
      const sent = await this.adapter.send(claim.row, {
        persistCronThread: (threadId) =>
          this.repository.setDeliveryThread(
            claim.row.id,
            claim.fencingToken,
            threadId,
          ),
      });
      // The final updateDelivery below already persists cronThreadId in the
      // same fenced write that moves the row to 'sent', so the separate
      // send-success setDeliveryThread above would only duplicate that write.
      // The pre-send persistCronThread path (invoked by the adapter right after
      // Discord thread creation and before the message send) remains the
      // crash-safety boundary that survives ambiguous/failed outcomes.
      this.repository.updateDelivery(claim.row.id, claim.fencingToken, "sent", {
        externalMessageId: sent.externalMessageId,
        ...(sent.cronThreadId ? { cronThreadId: sent.cronThreadId } : {}),
      });
      const deliveries = this.repository
        .listDeliveries()
        .filter((delivery) => delivery.jobId === claim.row.jobId);
      if (this.isRss(claim.row)) {
        if (deliveries.every((delivery) => delivery.status === "sent")) {
          this.settleRss(claim.row, "completed");
        }
      } else {
        this.settleRss(claim.row, "completed");
      }
    } catch (error) {
      const kind = error instanceof DeliveryError ? error.kind : "unknown";
      try {
        const rss = this.isRss(claim.row);
        if (rss) {
          this.repository.failRssDelivery(
            claim.row.id,
            claim.fencingToken,
            kind === "unknown" ? "ambiguous" : "failed",
            String(error),
          );
          this.settleRss(claim.row, "dead_letter");
        } else {
          this.repository.updateDelivery(
            claim.row.id,
            claim.fencingToken,
            kind === "unknown"
              ? "ambiguous"
              : kind === "non-retryable"
                ? "failed"
                : "retry_wait",
            {
              error: String(error),
              ...(kind === "retryable"
                ? {
                    retryAt: new Date(
                      Date.now() + (this.options.retryDelayMs ?? 1000),
                    ).toISOString(),
                  }
                : {}),
            },
          );
        }
      } catch (updateError) {
        console.error("[delivery] state update failed", updateError);
      }
    }
  }
  private isRss(row: DeliveryRow): boolean {
    if (!row.payloadJson) return false;
    try {
      return (
        typeof (JSON.parse(row.payloadJson) as Record<string, unknown>)
          .rssDispatchId === "string"
      );
    } catch {
      return false;
    }
  }

  private settleRss(
    row: DeliveryRow,
    resolution: "completed" | "dead_letter",
  ): void {
    if (!row.payloadJson) return;
    try {
      const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
      if (typeof payload.rssDispatchId !== "string") return;
      settleRssDispatch(
        typeof payload.rssStatePath === "string"
          ? payload.rssStatePath
          : undefined,
        payload.rssDispatchId,
        typeof payload.rssDispatchJobId === "string"
          ? payload.rssDispatchJobId
          : undefined,
        resolution,
      );
    } catch (error) {
      console.error("[delivery] RSS状態の更新に失敗しました", error);
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!(await this.runOnce()))
          await new Promise((resolve) =>
            setTimeout(resolve, this.options.pollMs ?? 1000),
          );
      } catch (error) {
        console.error("[delivery] worker error", error);
        await new Promise((resolve) =>
          setTimeout(resolve, this.options.pollMs ?? 1000),
        );
      }
    }
  }
}
let defaultWorker: DeliveryWorker | undefined;
export function startDeliveryWorker(
  repository: QueueRepository,
): DeliveryWorker {
  defaultWorker ??= new DeliveryWorker(repository);
  defaultWorker.start();
  return defaultWorker;
}
export function stopDeliveryWorker(): void {
  defaultWorker?.stop();
  defaultWorker = undefined;
}
