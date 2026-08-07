import { randomUUID } from "node:crypto";
import { client } from "../discord/client.js";
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
  destinationType?: string;
  destinationId?: string;
  replyMessageId?: string;
  cronJobId?: string;
  cronThreadId?: string;
}
type DeliveryTarget = {
  id?: unknown;
  isSendable?: () => boolean;
  send: (payload: unknown) => Promise<{ id?: unknown }>;
  threads?: { create: (options: { name: string }) => Promise<DeliveryTarget> };
};
export class DiscordDeliveryAdapter implements DeliveryAdapter {
  async send(
    row: DeliveryRow,
    context: DeliverySendContext = {},
  ): Promise<{ externalMessageId: string; cronThreadId?: string }> {
    const payload = JSON.parse(row.payloadJson ?? "{}") as DeliveryPayload;
    let sendAttempted = false;
    try {
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
            payload.destinationId ?? row.destinationId!,
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
        target = (client.channels.cache.get(
          payload.destinationId ?? row.destinationId!,
        ) ??
          (await client.channels.fetch(
            payload.destinationId ?? row.destinationId!,
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
      sendAttempted = true;
      const value =
        payload.replyMessageId && !threadId
          ? await target.send({
              content,
              reply: {
                messageReference: payload.replyMessageId,
                failIfNotExists: false,
              },
              allowedMentions: { repliedUser: true },
            })
          : await target.send(content);
      return {
        externalMessageId: String(value?.id ?? randomUUID()),
        ...(threadId ? { cronThreadId: threadId } : {}),
      };
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      const kind = classifyDiscordError(error);
      throw new DeliveryError(
        !sendAttempted && kind === "unknown" ? "retryable" : kind,
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
    this.workerId =
      options.workerId ?? `delivery-${process.pid}-${randomUUID().slice(0, 8)}`;
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
      typeof client.isReady === "function" &&
      !client.isReady()
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
      if (sent.cronThreadId && !claim.row.cronThreadId)
        this.repository.setDeliveryThread(
          claim.row.id,
          claim.fencingToken,
          sent.cronThreadId,
        );
      this.repository.updateDelivery(claim.row.id, claim.fencingToken, "sent", {
        externalMessageId: sent.externalMessageId,
        ...(sent.cronThreadId ? { cronThreadId: sent.cronThreadId } : {}),
      });
    } catch (error) {
      const kind = error instanceof DeliveryError ? error.kind : "unknown";
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
