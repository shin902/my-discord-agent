import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";
import { settleRssDispatch } from "./reconciliation.js";

export interface DeliveryResult {
  externalMessageId: string;
  cronThreadId?: string;
}

export type DeliverySendPayload =
  | string
  | {
      content: string;
      allowedMentions?: { parse?: readonly string[]; repliedUser: boolean };
      reply?: { messageReference: string; failIfNotExists: boolean };
    };
export interface DeliveryTarget {
  readonly id?: string;
  readonly isSendable: () => boolean;
  readonly send: (
    payload: DeliverySendPayload,
  ) => Promise<DeliveryMessageResponse>;
  readonly threads?: {
    readonly create: (options: { name: string }) => Promise<DeliveryTarget>;
  };
}
export interface DeliveryClient {
  readonly isReady: () => boolean;
  readonly channels: {
    readonly cache: {
      readonly get: (id: string) => DeliveryTarget | undefined;
    };
    readonly fetch: (id: string) => Promise<DeliveryTarget | null>;
  };
}
export interface DeliveryMessageResponse {
  readonly id?: string;
}

function adaptDiscordClient(
  client: Awaited<ReturnType<typeof getDiscordClientForGroupName>>,
): DeliveryClient {
  return {
    isReady: () => client.isReady(),
    channels: {
      cache: { get: (id) => adaptDiscordTarget(client.channels.cache.get(id)) },
      fetch: async (id) =>
        adaptDiscordTarget(await client.channels.fetch(id)) ?? null,
    },
  };
}
function adaptDiscordTarget(
  target:
    | Awaited<
        ReturnType<
          Awaited<
            ReturnType<typeof getDiscordClientForGroupName>
          >["channels"]["fetch"]
        >
      >
    | null
    | undefined,
): DeliveryTarget | undefined {
  if (!target || !target.isSendable()) return undefined;
  return {
    id: target.id,
    isSendable: () => target.isSendable(),
    send: async (payload) => {
      const text = z.string().safeParse(payload);
      if (text.success)
        return { id: (await target.send({ content: text.data })).id };
      const objectPayload = z
        .object({
          content: z.string(),
          allowedMentions: z.object({ repliedUser: z.boolean() }).optional(),
          reply: z
            .object({
              messageReference: z.string(),
              failIfNotExists: z.boolean(),
            })
            .optional(),
        })
        .parse(payload);
      const response = await target.send(objectPayload);
      return { id: response.id };
    },
  };
}
export interface DiscordDeliveryDependencies {
  resolveClient: (groupName: string) => Promise<DeliveryClient>;
  clientsReady: () => boolean;
}
const defaultDiscordDependencies: DiscordDeliveryDependencies = {
  resolveClient: async (groupName) =>
    adaptDiscordClient(await getDiscordClientForGroupName(groupName)),
  clientsReady: () =>
    [...getDiscordClients().values()].some((value) => value.isReady()),
};

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
  ): Promise<DeliveryResult>;
}
type DeliveryUpdate = { error: string; retryAt?: string };
type DeliverySentUpdate = { externalMessageId: string; cronThreadId?: string };
const deliveryPayloadSchema = z.object({
  content: z.string().optional(),
  groupName: z.string().optional(),
  destinationType: z.string().optional(),
  destinationId: z.string().optional(),
  replyMessageId: z.string().optional(),
  allowMention: z.boolean().optional(),
  cronJobId: z.string().optional(),
  cronThreadId: z.string().optional(),
  rssDispatchId: z.string().optional(),
  rssStatePath: z.string().optional(),
  rssDispatchJobId: z.string().optional(),
});
type DeliveryPayload = z.infer<typeof deliveryPayloadSchema>;
function parseDeliveryPayload(json: string | null): DeliveryPayload {
  return deliveryPayloadSchema.parse(JSON.parse(json ?? "{}"));
}
function parseRssPayload(
  json: string | null,
):
  | { rssDispatchId: string; rssStatePath?: string; rssDispatchJobId?: string }
  | undefined {
  const payload = parseDeliveryPayload(json);
  return payload.rssDispatchId
    ? {
        rssDispatchId: payload.rssDispatchId,
        rssStatePath: payload.rssStatePath,
        rssDispatchJobId: payload.rssDispatchJobId,
      }
    : undefined;
}
function statusCode(cause: unknown): number | undefined {
  const parsed = z
    .object({
      status: z.number().optional(),
      statusCode: z.number().optional(),
    })
    .passthrough()
    .safeParse(cause);
  if (!parsed.success) return undefined;
  return parsed.data.status ?? parsed.data.statusCode;
}
export function classifyDiscordError(cause: unknown): DeliveryErrorKind {
  const status = statusCode(cause);
  if (status !== undefined)
    return status === 429 || status >= 500 ? "retryable" : "non-retryable";
  if (
    cause instanceof TypeError ||
    (cause instanceof Error &&
      /timeout|network|econn|socket|fetch/i.test(cause.message))
  )
    return "retryable";
  return "unknown";
}
export class DiscordDeliveryAdapter implements DeliveryAdapter {
  constructor(
    private readonly dependencies: DiscordDeliveryDependencies = defaultDiscordDependencies,
  ) {}
  dependenciesReady(): boolean {
    return this.dependencies.clientsReady();
  }
  async send(
    row: DeliveryRow,
    context: DeliverySendContext = {},
  ): Promise<DeliveryResult> {
    const payload = parseDeliveryPayload(row.payloadJson);
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
      let client: DeliveryClient;
      try {
        client = await this.dependencies.resolveClient(payload.groupName);
      } catch (error) {
        throw new DeliveryError(
          "non-retryable",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      if (!client.isReady())
        throw new DeliveryError("retryable", "Discord client is not ready");
      let threadId = row.cronThreadId ?? payload.cronThreadId;
      let target: DeliveryTarget | undefined;
      if (
        payload.destinationType === "new-thread" ||
        row.destinationType === "new-thread"
      ) {
        if (threadId) {
          target = (await client.channels.fetch(threadId)) ?? undefined;
        } else {
          const channel = await client.channels.fetch(destinationId);
          if (!channel)
            throw new DeliveryError(
              "retryable",
              "destination channel is unavailable",
            );
          if (!channel.threads)
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
        target =
          client.channels.cache.get(destinationId) ??
          (await client.channels.fetch(destinationId)) ??
          undefined;
      }
      if (!target)
        throw new DeliveryError(
          "retryable",
          "destination channel is unavailable",
        );
      if (!target.isSendable())
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
              messageReference: payload.replyMessageId ?? "",
              failIfNotExists: false,
            },
            // allowMention=true は従来の送信形式を維持する。
            allowedMentions,
          })
        : await target.send(
            allowMention ? content : { content, allowedMentions },
          );
      const sent = {
        externalMessageId: String(value.id ?? randomUUID()),
        cronThreadId: threadId,
      } satisfies DeliveryResult;
      return sent;
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
      !this.adapterReady()
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
  private adapterReady(): boolean {
    return this.adapter instanceof DiscordDeliveryAdapter
      ? this.adapter.dependenciesReady()
      : true;
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
      const update: DeliverySentUpdate = {
        externalMessageId: sent.externalMessageId,
      };
      if (sent.cronThreadId) update.cronThreadId = sent.cronThreadId;
      this.repository.updateDelivery(
        claim.row.id,
        claim.fencingToken,
        "sent",
        update,
      );
      if (this.isRss(claim.row)) {
        const deliveries = this.repository
          .listDeliveries()
          .filter((delivery) => delivery.jobId === claim.row.jobId);
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
            (() => {
              const update: DeliveryUpdate = {
                error: String(error),
              };
              if (kind === "retryable") {
                update.retryAt = new Date(
                  Date.now() + (this.options.retryDelayMs ?? 1000),
                ).toISOString();
              }
              return update;
            })(),
          );
        }
      } catch (updateError) {
        console.error("[delivery] state update failed", updateError);
      }
    }
  }
  private isRss(row: DeliveryRow): boolean {
    try {
      return parseRssPayload(row.payloadJson) !== undefined;
    } catch {
      return false;
    }
  }

  private settleRss(
    row: DeliveryRow,
    resolution: "completed" | "dead_letter",
  ): void {
    try {
      const payload = parseRssPayload(row.payloadJson);
      if (!payload) return;
      settleRssDispatch(
        payload.rssStatePath,
        payload.rssDispatchId,
        payload.rssDispatchJobId,
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
