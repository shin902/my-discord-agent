import { randomUUID } from "node:crypto";
import { ChannelType, type Client } from "discord.js";
import { renameSession } from "../agent/session.js";
import { acknowledgeEmail } from "../cron/mail-ack.js";
import {
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";
import { settleRssDispatch } from "./reconciliation.js";

const MAX_CRON_PLACEHOLDER_ATTEMPTS = 3;

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
  promoteCronItemSession?: (cronThreadId: string) => Promise<void> | void;
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
  mailEmailId?: string;
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

      const destinationType = payload.destinationType ?? row.destinationType;
      const isItemThread = destinationType === "item-thread";
      let threadId = row.cronThreadId ?? payload.cronThreadId;
      let target: DeliveryTarget | undefined;
      if (destinationType === "new-thread") {
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
        // The job stores the parent/thread ID before delivery persistence. If
        // recovery finds that marker while the thread itself is not visible
        // yet, fetch the parent message and finish starting the same thread.
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
          allowMention ? content : { content, allowedMentions },
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
          // immediate user reply always finds the renamed JSONL. The remote
          // thread is started before delivery persistence so a retry can use
          // the durable job marker if persistence fails.
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

      // Legacy pre-provisioned item threads may still carry a placeholder.
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
          throw new DeliveryError(
            "retryable",
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
        promoteCronItemSession: async (threadId) => {
          const job = this.repository.get(claim.row.jobId);
          if (!job) throw new Error(`unknown job ${claim.row.jobId}`);
          const promotedConversationPath = job.conversationPath
            ? `data/sessions/${job.groupName}/${threadId}.jsonl`
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
      const allSent = deliveries.every(
        (delivery) => delivery.status === "sent",
      );
      if (this.isRss(claim.row)) {
        if (allSent) this.settleRss(claim.row, "completed");
      } else {
        this.settleRss(claim.row, "completed");
      }
      if (allSent) await this.acknowledgeMail(claim.row);
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
          const placeholder = this.isCronPlaceholder(claim.row);
          const terminalPlaceholderFailure =
            placeholder &&
            Number(claim.row.attempts ?? 0) >= MAX_CRON_PLACEHOLDER_ATTEMPTS;
          const status = terminalPlaceholderFailure
            ? "failed"
            : placeholder
              ? "retry_wait"
              : kind === "unknown"
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
  private isCronPlaceholder(row: DeliveryRow): boolean {
    if (!row.payloadJson) return false;
    try {
      return (
        typeof (JSON.parse(row.payloadJson) as Record<string, unknown>)
          .cronPlaceholderMessageId === "string"
      );
    } catch {
      return false;
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

  private async acknowledgeMail(row: DeliveryRow): Promise<void> {
    if (!row.payloadJson) return;
    try {
      const payload = JSON.parse(row.payloadJson) as DeliveryPayload;
      if (typeof payload.mailEmailId !== "string") return;
      await acknowledgeEmail(payload.mailEmailId);
    } catch (error) {
      console.error("[mail] Discord配送後の既読化に失敗:", error);
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
