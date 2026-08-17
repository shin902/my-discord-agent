import { randomUUID } from "node:crypto";
import type { Client } from "discord.js";
import {
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";

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
    public readonly cronThreadId?: string,
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
}
type DeliveryTarget = {
  id?: unknown;
  isSendable?: () => boolean;
  send: (payload: unknown) => Promise<{ id?: unknown }>;
  threads?: { create: (options: { name: string }) => Promise<DeliveryTarget> };
};

function formatDeliveryError(error: unknown): string {
  const text = `⚠️ エラー: ${String(error)}`;
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text;
}

async function reportDeliveryError(
  row: DeliveryRow,
  threadId: string,
  error: unknown,
): Promise<void> {
  let groupName: string | undefined;
  try {
    const payload = JSON.parse(row.payloadJson ?? "{}") as DeliveryPayload;
    groupName = payload.groupName;
  } catch {
    // A malformed payload is already a delivery failure; there is no safe
    // group/client identity from which to report it.
  }
  if (!groupName) return;
  try {
    const client = await resolveDiscordClient(groupName);
    const target = (await client.channels.fetch(
      threadId,
    )) as unknown as DeliveryTarget | null;
    if (!target?.isSendable?.()) return;
    await target.send({
      content: formatDeliveryError(error),
      allowedMentions: { parse: [], repliedUser: false },
    });
  } catch (reportError) {
    // Error reporting is best effort and must not change the delivery retry
    // state determined by the original failure.
    console.error("[delivery] cron thread error report failed", reportError);
  }
}

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
    let threadId = row.cronThreadId ?? payload.cronThreadId;
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
      const reply = payload.replyMessageId && !threadId;
      const allowedMentions = allowMention
        ? { repliedUser: true }
        : { parse: [], repliedUser: false };
      mutationAttempted = true;
      const value = reply
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
      const kind =
        error instanceof DeliveryError
          ? error.kind
          : classifyDiscordError(error);
      const status = statusCode(error);
      // After create/send starts, a 5xx response does not prove that Discord
      // rejected the mutation. Treat it like a lost transport response rather
      // than retrying and potentially duplicating a thread or message. A 429 is
      // safe to retry because it explicitly reports rate-limit rejection.
      const postMutationAmbiguous =
        !(error instanceof DeliveryError) &&
        mutationAttempted &&
        (status !== undefined
          ? status >= 500
          : kind === "retryable" || kind === "unknown");
      const effectiveKind = postMutationAmbiguous
        ? "unknown"
        : error instanceof DeliveryError
          ? error.kind
          : kind === "unknown"
            ? "retryable"
            : kind;
      const normalized =
        error instanceof DeliveryError
          ? error
          : new DeliveryError(
              effectiveKind,
              error instanceof Error ? error.message : String(error),
              error,
            );
      // The worker uses this identity to report failures without creating a
      // second thread. It is set for both newly-created and already-persisted
      // destinations, including failures while persisting a newly-created ID.
      if (threadId && normalized.cronThreadId !== threadId) {
        throw new DeliveryError(
          normalized.kind,
          normalized.message,
          normalized.cause ?? error,
          threadId,
        );
      }
      throw normalized;
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
    } catch (error) {
      const kind = error instanceof DeliveryError ? error.kind : "unknown";
      let threadId =
        (error instanceof DeliveryError ? error.cronThreadId : undefined) ??
        claim.row.cronThreadId;
      if (!threadId) {
        try {
          threadId = this.repository.getDelivery(claim.row.jobId)?.cronThreadId;
        } catch (lookupError) {
          console.error("[delivery] cron thread lookup failed", lookupError);
        }
      }
      if (threadId) await reportDeliveryError(claim.row, threadId, error);
      try {
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
      } catch (updateError) {
        console.error("[delivery] state update failed", updateError);
      }
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
