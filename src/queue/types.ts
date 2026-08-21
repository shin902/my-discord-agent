import type { ModelConfig, SkillSelection } from "../config/groups.js";

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
  configOverride?: {
    model?: ModelConfig;
    tools?: string[];
    skills?: SkillSelection;
  };
  attachments?: AttachmentRef[];
  agentsSnapshotContent?: string;
  memorySnapshotContent?: string;
  agentsSnapshotPresent?: boolean;
  memorySnapshotPresent?: boolean;
  snapshotPresent?: boolean;
  snapshotHash?: string;
  toolCallKey?: string;
  /** Runtime lease metadata, populated only after a durable claim. */
  fencingToken?: number;
  workerId?: string;
  lastError?: string;
}

export type QueueInput = Omit<InboxMessage, "id" | "retries" | "enqueuedAt">;

/** Explicit callback contract used by queue producers. */
export type QueueProducer = (message: QueueInput) => Promise<void> | void;
