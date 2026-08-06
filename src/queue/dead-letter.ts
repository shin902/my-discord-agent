import { getQueueRepository } from "./repository.js";
import type { InboxMessage } from "./inbox.js";

/** Dead-letter rows are durable SQLite records; JSONL is no longer an active writer. */
export async function appendDeadLetter(
  msg: InboxMessage,
  reason = "dead_letter",
  error?: string,
): Promise<void> {
  const repo = getQueueRepository();
  const job = repo.get(msg.id);
  if (!job || job.status === "completed" || job.status === "dead_letter") return;
  repo.deadLetter(msg.id, msg.fencingToken ?? job.fencingToken, reason, error);
}

/** Preserve malformed legacy input as an audit row without replaying it. */
export async function appendCorruptedDeadLetter(rawLine: string): Promise<void> {
  getQueueRepository().recordDeadLetter({
    reason: "malformed_jsonl",
    error: rawLine,
    source: "migration",
  });
}
