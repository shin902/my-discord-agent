import { randomUUID } from "node:crypto";
import { ChannelType, type Client } from "discord.js";
import { renameSession, sessionConversationPath } from "../agent/session.js";
import {
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";
import { withDiscordSendOptions } from "../discord/send-options.js";

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
import type { SourceEnvelope, ThreadRoute } from "./source-handlers.js";
import { SourceHandlers } from "./source-handlers.js";

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
  /** True when this is the final persisted response chunk for the job. */
  isFinalChunk?: boolean;
  persistCronThread?: (cronThreadId: string) => Promise<void> | void;
  promoteCronItemSession?: (cronThreadId: string) => Promise<void> | void;
  threadRoute?: (
    envelope: SourceEnvelope,
    groupName: string,
    channelId: string,
  ) => ThreadRoute | undefined;
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
  feature?: SourceEnvelope;
}
type DeliveryMessage = {
  id?: unknown;
  startThread?: (options: { name: string }) => Promise<{ id?: unknown }>;
};
type DeliveryTarget = {
  id?: unknown;
  type?: number;
  isSendable?: () => boolean;
  send: (payload: unknown) => Promise<DeliveryMessage>;
  startThread?: (options: { name: string }) => Promise<DeliveryTarget>;
  edit?: (payload: unknown) => Promise<unknown>;
  messages?: { fetch: (id: string) => Promise<DeliveryTarget> };
  threads?: { create: (options: { name: string }) => Promise<DeliveryTarget> };
};
export class DiscordDeliveryAdapter implements DeliveryAdapter {
  async send(
    row: DeliveryRow,
    context: DeliverySendContext = {},
  ): Promise<{ externalMessageId: string; cronThreadId?: string }> {
    const rawPayload = JSON.parse(row.payloadJson ?? "{}") as Record<
      string,
      unknown
    >;
    if (typeof rawPayload.cronPlaceholderMessageId === "string") {
      throw new DeliveryError(
        "non-retryable",
        "pre-materialized item-thread delivery is no longer supported",
      );
    }
    const payload = rawPayload as DeliveryPayload;
    // Direct adapter calls represent a single response unless the worker
    // supplies the durable chunk position explicitly.
    const suppressEmbeds = context.isFinalChunk === false;
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

      const destinationType = payload.destinationType ?? row.destinationType;
      const isItemThread = destinationType === "item-thread";
      let threadId = row.cronThreadId ?? payload.cronThreadId;
      let target: DeliveryTarget | undefined;
      const route = payload.feature
        ? context.threadRoute?.(
            payload.feature,
            payload.groupName,
            destinationId,
          )
        : undefined;
      if (destinationType === "channel" && route) {
        threadId = route.resolve();
        if (threadId) {
          try {
            target = (await client.channels.fetch(
              threadId,
            )) as unknown as DeliveryTarget;
            if (!target) threadId = undefined;
          } catch (error) {
            if (statusCode(error) !== 404) throw error;
            threadId = undefined;
          }
        }
        if (!threadId) {
          const channel = (await client.channels.fetch(
            destinationId,
          )) as unknown as DeliveryTarget | null;
          if (!channel)
            throw new DeliveryError(
              "retryable",
              "destination channel is unavailable",
            );
          if (
            (channel.type !== ChannelType.GuildText &&
              channel.type !== ChannelType.GuildAnnouncement) ||
            typeof channel.threads?.create !== "function"
          )
            throw new DeliveryError(
              "non-retryable",
              "routed thread requires a parent text channel",
            );
          mutationAttempted = true;
          target = await channel.threads.create({ name: route.name });
          threadId = String(target.id ?? "");
          if (!threadId)
            throw new DeliveryError("unknown", "Discord thread ID is empty");
          try {
            await route.persist(threadId);
          } catch (error) {
            throw new DeliveryError(
              "unknown",
              `failed to persist routed Discord thread ${threadId}`,
              error,
            );
          }
        }
      } else if (destinationType === "new-thread") {
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
      } else if (isItemThread && threadId) {
        // The late-materialization path durably stores the parent/thread ID
        // before delivery completion. Recovery reuses that same ID instead of
        // creating a second parent message or thread.
        try {
          target = (await client.channels.fetch(
            threadId,
          )) as unknown as DeliveryTarget;
        } catch (error) {
          const channel = (await client.channels.fetch(
            destinationId,
          )) as unknown as DeliveryTarget | null;
          const parent = await channel?.messages?.fetch(threadId);
          if (!parent?.startThread) throw error;
          target = await parent.startThread({
            name: `cron-${String(payload.cronJobId ?? row.jobId).slice(0, 90)}`,
          });
          const createdThreadId = String(target.id ?? threadId);
          if (createdThreadId !== threadId) {
            throw new Error(
              `item-thread ID mismatch: message=${threadId} thread=${createdThreadId}`,
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

      if (isItemThread && !threadId) {
        if (
          target.type !== undefined &&
          target.type !== ChannelType.GuildText &&
          target.type !== ChannelType.GuildAnnouncement
        ) {
          throw new DeliveryError(
            "non-retryable",
            "destination does not support message threads",
          );
        }
        mutationAttempted = true;
        const parent = await target.send(
          withDiscordSendOptions(
            allowMention ? content : { content, allowedMentions },
            suppressEmbeds,
          ),
        );
        const parentId = String(parent.id ?? "");
        if (!parentId) {
          throw new DeliveryError(
            "unknown",
            "item-thread parent message ID is empty",
          );
        }
        try {
          // Start Thread from Message uses the source message ID as the thread
          // ID. Promote the session before the thread becomes visible so an
          // immediate user reply always finds the renamed session trajectory.
          // The remote thread is started before delivery persistence so a retry
          // can use the durable job marker if persistence fails.
          await context.promoteCronItemSession?.(parentId);
        } catch (error) {
          throw new DeliveryError(
            "unknown",
            `failed to promote item-thread session ${parentId}`,
            error,
          );
        }
        if (typeof parent.startThread !== "function") {
          throw new DeliveryError(
            "unknown",
            "item-thread parent message does not support startThread",
          );
        }
        try {
          const thread = await parent.startThread({
            name: `cron-${String(payload.cronJobId ?? row.jobId).slice(0, 90)}`,
          });
          const createdThreadId = String(thread.id ?? parentId);
          if (createdThreadId !== parentId) {
            throw new Error(
              `item-thread ID mismatch: message=${parentId} thread=${createdThreadId}`,
            );
          }
        } catch (error) {
          throw new DeliveryError(
            "unknown",
            `failed to start item-thread ${parentId}`,
            error,
          );
        }
        try {
          await context.persistCronThread?.(parentId);
        } catch (error) {
          throw new DeliveryError(
            "unknown",
            `failed to persist item-thread ${parentId}`,
            error,
          );
        }
        return { externalMessageId: parentId, cronThreadId: parentId };
      }

      const reply = payload.replyMessageId && !threadId;
      mutationAttempted = true;
      const value = reply
        ? await target.send(
            withDiscordSendOptions(
              {
                content,
                reply: {
                  messageReference: payload.replyMessageId,
                  failIfNotExists: false,
                },
                allowedMentions,
              },
              suppressEmbeds,
            ),
          )
        : await target.send(
            withDiscordSendOptions(
              allowMention ? content : { content, allowedMentions },
              suppressEmbeds,
            ),
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
    private readonly sources: SourceHandlers = new SourceHandlers(),
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
    const sourceJob = this.repository.get(claim.row.jobId);
    const unsupportedPreMaterializedItemThread =
      sourceJob?.cronDeliveryMode === "item-thread" &&
      sourceJob.cronProvisioning !== true &&
      claim.row.destinationType === "new-thread";
    try {
      const envelope = this.sourceOf(claim.row);
      if (envelope) {
        try {
          this.sources.policy(envelope);
        } catch (error) {
          throw new DeliveryError("non-retryable", String(error), error);
        }
      }
      if (unsupportedPreMaterializedItemThread) {
        throw new DeliveryError(
          "non-retryable",
          "pre-materialized item-thread delivery is no longer supported",
        );
      }
      const responseIndex = claim.row.responseIndex ?? 0;
      const isFinalChunk = !this.repository
        .listDeliveries()
        .some(
          (delivery) =>
            delivery.jobId === claim.row.jobId &&
            (delivery.responseIndex ?? 0) > responseIndex,
        );
      const sent = await this.adapter.send(claim.row, {
        isFinalChunk,
        persistCronThread: (threadId) =>
          this.repository.setDeliveryThread(
            claim.row.id,
            claim.fencingToken,
            threadId,
          ),
        threadRoute: (envelope, groupName, channelId) =>
          this.sources.threadRoute(envelope, groupName, channelId),
        promoteCronItemSession: async (threadId) => {
          const job = this.repository.get(claim.row.jobId);
          if (!job) throw new Error(`unknown job ${claim.row.jobId}`);
          const promotedConversationPath = job.conversationPath
            ? sessionConversationPath(job.groupName, threadId)
            : undefined;
          if (job.sessionId === threadId) {
            if (
              promotedConversationPath &&
              job.conversationPath !== promotedConversationPath
            ) {
              const changed = this.repository.db
                .prepare(
                  "UPDATE jobs SET conversation_path=?,updated_at=? WHERE id=?",
                )
                .run(
                  promotedConversationPath,
                  new Date().toISOString(),
                  job.id,
                );
              if (changed.changes !== 1)
                throw new Error(`unknown job ${job.id}`);
            }
            return;
          }
          const originalSessionId = job.sessionId;
          const originalConversationPath = job.conversationPath;
          await renameSession(job.groupName, originalSessionId, threadId);
          try {
            if (promotedConversationPath) {
              const changed = this.repository.db
                .prepare(
                  "UPDATE jobs SET conversation_path=?,updated_at=? WHERE id=?",
                )
                .run(
                  promotedConversationPath,
                  new Date().toISOString(),
                  job.id,
                );
              if (changed.changes !== 1)
                throw new Error(`unknown job ${job.id}`);
            }
            const promoted = this.repository.provisionCronJob(
              job.id,
              threadId,
              {
                cronThreadId: threadId,
              },
            );
            if (!promoted) throw new Error(`unknown job ${job.id}`);
          } catch (error) {
            if (originalConversationPath) {
              try {
                this.repository.db
                  .prepare(
                    "UPDATE jobs SET conversation_path=?,updated_at=? WHERE id=?",
                  )
                  .run(
                    originalConversationPath,
                    new Date().toISOString(),
                    job.id,
                  );
              } catch {}
            }
            await renameSession(
              job.groupName,
              threadId,
              originalSessionId,
            ).catch(() => {});
            throw error;
          }
        },
      });
      // The final updateDelivery below already persists cronThreadId in the
      // same fenced write that moves the row to 'sent', so the separate
      // send-success setDeliveryThread above would only duplicate that write.
      // persistCronThread is still used before a newly-created thread becomes
      // visible so later response chunks resolve the same destination.
      this.repository.updateDelivery(claim.row.id, claim.fencingToken, "sent", {
        externalMessageId: sent.externalMessageId,
        ...(sent.cronThreadId ? { cronThreadId: sent.cronThreadId } : {}),
      });
      const deliveries = this.repository
        .listDeliveries()
        .filter((delivery) => delivery.jobId === claim.row.jobId);
      await this.notifySource(claim.row, deliveries);
    } catch (error) {
      const kind = error instanceof DeliveryError ? error.kind : "unknown";
      try {
        const source = this.sourceOf(claim.row);
        let continueAfterFailedChunk = false;
        if (source) {
          try {
            continueAfterFailedChunk =
              this.sources.policy(source).continueAfterFailedChunk;
          } catch {
            continueAfterFailedChunk = false;
          }
        }
        if (continueAfterFailedChunk || unsupportedPreMaterializedItemThread) {
          this.repository.failDeliveryBatch(
            claim.row.id,
            claim.fencingToken,
            kind === "unknown" ? "ambiguous" : "failed",
            String(error),
          );
          if (source) {
            await this.notifySource(
              claim.row,
              this.repository
                .listDeliveries()
                .filter((row) => row.jobId === claim.row.jobId),
            );
          }
        } else {
          const status =
            kind === "unknown"
              ? "ambiguous"
              : kind === "non-retryable"
                ? "failed"
                : "retry_wait";
          this.repository.updateDelivery(
            claim.row.id,
            claim.fencingToken,
            status,
            {
              error: String(error),
              ...(status === "retry_wait"
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

  private sourceOf(row: DeliveryRow): SourceEnvelope | undefined {
    if (!row.payloadJson) return undefined;
    try {
      const payload = JSON.parse(row.payloadJson) as {
        feature?: SourceEnvelope;
      };
      return payload.feature;
    } catch {
      return undefined;
    }
  }

  private async notifySource(
    row: DeliveryRow,
    deliveries: readonly DeliveryRow[],
  ): Promise<void> {
    const source = this.sourceOf(row);
    if (!source) return;
    try {
      await this.sources.delivery(
        source,
        row,
        deliveries.map((delivery) => delivery.status),
      );
    } catch (error) {
      // Discord state is already fenced and durable. External ACK failure is
      // recovered by the source's own unread/claim reconciliation path.
      console.error(
        `[delivery] ${source.kind} source finalization failed:`,
        error,
      );
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
  sources: SourceHandlers = new SourceHandlers(),
): DeliveryWorker {
  defaultWorker ??= new DeliveryWorker(repository, undefined, {}, sources);
  defaultWorker.start();
  return defaultWorker;
}
export function stopDeliveryWorker(): void {
  defaultWorker?.stop();
  defaultWorker = undefined;
}
