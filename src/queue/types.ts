import type { AgentConfig } from "../config/groups.js";

export type CronDeliveryMode = "direct" | "new-thread" | "item-thread";
export type CronSessionMode = "per-run" | "destination";

export interface AttachmentRef {
  url: string;
  name: string;
  contentType: string | null;
  size: number;
}

export interface InboxMessage {
  id: string;
  channelId: string;
  groupName: string;
  sessionId: string;
  messageId?: string;
  content: string;
  timestamp: string;
  enqueuedAt?: string;
  retries: number;
  idempotencyKey?: string;
  completedAt?: string;
  cronDeliveryMode?: CronDeliveryMode;
  cronSessionMode?: CronSessionMode;
  /** Add the NO_REPLY protocol instruction to this cron request's system prompt. */
  cronNoReply?: boolean;
  cronThread?: boolean;
  cronJobId?: string;
  cronThreadId?: string;
  /** Placeholder message created before cron AI execution. */
  cronPlaceholderMessageId?: string;
  /** Mail message to acknowledge only after every Discord delivery is sent. */
  mailEmailId?: string;
  /** Item-thread jobs remain claimable so the poller can provision their destination before AI execution. */
  cronProvisioning?: boolean;
  cronFailureNotified?: boolean;
  rssDispatchId?: string;
  rssStatePath?: string;
  /** A one-shot persistent Bot profile selected by a Discord command. */
  botId?: string;
  /** AgentConfig fields selected by Discord channel intake or a cron job. */
  configOverride?: Partial<AgentConfig>;
  attachments?: AttachmentRef[];
  systemPromptSnapshotContent?: string;
  memorySnapshotContent?: string;
  systemPromptSnapshotPresent?: boolean;
  memorySnapshotPresent?: boolean;
  snapshotPresent?: boolean;
  snapshotHash?: string;
  toolCallKey?: string;
  /** Runtime lease metadata, populated only after a durable claim. */
  fencingToken?: number;
  workerId?: string;
  lastError?: string;
}

/** Normalize payload fields written before system-prompt snapshot terminology was introduced. */
export function normalizeInboxMessagePayload(
  payload: InboxMessage,
): InboxMessage {
  const normalized = { ...payload } as InboxMessage &
    Record<string, unknown> & {
      agentsSnapshotContent?: string;
      agentsSnapshotPresent?: boolean;
    };
  if (
    normalized.systemPromptSnapshotContent === undefined &&
    normalized.agentsSnapshotContent !== undefined
  ) {
    normalized.systemPromptSnapshotContent = normalized.agentsSnapshotContent;
  }
  if (
    normalized.systemPromptSnapshotPresent === undefined &&
    normalized.agentsSnapshotPresent !== undefined
  ) {
    normalized.systemPromptSnapshotPresent = normalized.agentsSnapshotPresent;
  }
  delete normalized.agentsSnapshotContent;
  delete normalized.agentsSnapshotPresent;
  return normalized;
}

export type QueueInput = Omit<InboxMessage, "id" | "retries" | "enqueuedAt">;

/** Explicit callback contract used by queue producers. */
export type QueueProducer = (message: QueueInput) => Promise<void> | void;
