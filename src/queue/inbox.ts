import type { ModelConfig, SkillSelection } from "../config/groups.js";
import { getQueueRepository, type QueueRepository } from "./repository.js";

function resolveRepository(repository?: QueueRepository): QueueRepository {
  return repository ?? getQueueRepository();
}
export type CronDeliveryMode = "direct" | "new-thread";
export type CronSessionMode = "per-run" | "destination";
export interface AttachmentRef { url: string; name: string; contentType: string | null; size: number }
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
  rssDispatchId?: string;
  rssStatePath?: string;
  configOverride?: { model?: ModelConfig; tools?: string[]; skills?: SkillSelection };
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

/** Compatibility producer API; SQLite is the only active queue writer. */
export async function appendInbox(msg: QueueInput, repository?: QueueRepository): Promise<void> {
  resolveRepository(repository).enqueue(msg, { idempotencyKey: msg.idempotencyKey });
}

export async function peekAllUnclaimedInbox(excludeIds: ReadonlySet<string> = new Set(), repository?: QueueRepository): Promise<InboxMessage[]> {
  return resolveRepository(repository).list().filter((job) =>
    (job.status === "queued" || job.status === "retry_wait") && !excludeIds.has(job.id),
  );
}

export async function claimInbox(workerId: string, leaseMs: number, excludeIds: ReadonlySet<string> = new Set(), repository?: QueueRepository): Promise<InboxMessage | undefined> {
  return resolveRepository(repository).claim(workerId, leaseMs, new Date(), excludeIds)?.job;
}
export async function renewInboxLease(id: string, fencingToken: number, leaseMs = 60_000, repository?: QueueRepository): Promise<void> {
  resolveRepository(repository).heartbeat(id, fencingToken, leaseMs);
}

export async function markInboxRunning(id: string, fencingToken: number, metadata: Parameters<QueueRepository["markRunning"]>[2] = {}, repository?: QueueRepository): Promise<void> {
  resolveRepository(repository).markRunning(id, fencingToken, metadata);
}

export async function heartbeatInbox(id: string, fencingToken: number, leaseMs = 60_000, repository?: QueueRepository): Promise<void> {
  resolveRepository(repository).heartbeat(id, fencingToken, leaseMs);
}

export async function freezeInboxExecutionIdentity(
  id: string,
  fencingToken: number,
  identity: Parameters<QueueRepository["freezeExecutionIdentity"]>[2] = {},
  repository?: QueueRepository,
): Promise<void> {
  resolveRepository(repository).freezeExecutionIdentity(id, fencingToken, identity);
}

export async function commitInboxResult(
  id: string,
  fencingToken: number,
  result: unknown,
  options: Parameters<QueueRepository["commitResult"]>[3] = {},
  repository?: QueueRepository,
): Promise<void> {
  resolveRepository(repository).commitResult(id, fencingToken, result, options);
}

export async function removeInboxById(id: string, fencingToken?: number, repository?: QueueRepository): Promise<void> {
  const repo = resolveRepository(repository);
  const job = repo.get(id);
  if (!job || job.status === "completed" || job.status === "dead_letter") return;
  repo.complete(id, fencingToken ?? job.fencingToken);
}

export async function updateInboxById(id: string, patch: Partial<InboxMessage>, fencingToken?: number, repository?: QueueRepository, metadata: Parameters<QueueRepository["retry"]>[5] = {}): Promise<void> {
  const repo = resolveRepository(repository);
  const job = repo.get(id);
  if (!job || (job.status !== "running" && job.status !== "claimed")) return;
  const token = fencingToken ?? job.fencingToken;
  if (patch.retries !== undefined && patch.retries > job.retries) {
    const delay = Math.min(1000 * 2 ** job.retries, 60_000);
    repo.retry(id, token, patch.lastError ?? "retry", delay, patch, metadata);
  } else {
    repo.updateRunning(id, token, patch);
  }
}

export async function failInboxAttempt(
  id: string,
  error: unknown,
  fencingToken: number | undefined,
  metadata: Parameters<QueueRepository["retry"]>[5] = {},
  repository?: QueueRepository,
  payloadPatch?: Partial<InboxMessage>,
): Promise<void> {
  const repo = resolveRepository(repository);
  const job = repo.get(id);
  if (!job || (job.status !== "running" && job.status !== "claimed")) return;
  repo.retry(
    id,
    fencingToken ?? job.fencingToken,
    error,
    Math.min(1000 * 2 ** job.retries, 60_000),
    payloadPatch,
    metadata,
  );
}

export async function deadLetterInbox(id: string, reason: string, error?: string, fencingToken?: number, repository?: QueueRepository, metadata: Parameters<QueueRepository["deadLetter"]>[4] = {}): Promise<void> {
  const repo = resolveRepository(repository);
  const job = repo.get(id);
  if (!job || job.status === "dead_letter" || job.status === "completed") return;
  repo.deadLetter(id, fencingToken ?? job.fencingToken, reason, error, metadata);
}
