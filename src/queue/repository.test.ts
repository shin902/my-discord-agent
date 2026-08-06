import { describe, expect, it } from "vitest";
import { QueueRepository, openRuntimeDb } from "./repository.js";

describe("QueueRepository lease renewal", () => {
  it("extends a claimed lease with its fencing token", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const enqueued = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      const claimed = repo.claim("worker-a", 100);
      expect(claimed).toBeDefined();
      repo.renew(enqueued.job.id, claimed!.fencingToken, 10_000);
      const later = new Date(Date.now() + 500).toISOString();
      expect(repo.claim("worker-b", 100, new Date(later))).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it("dead-letters an expired lease at max attempts before reclaiming it", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const enqueued = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
      }, { idempotencyKey: "crash-reclaim", maxAttempts: 1 });
      const claimed = repo.claim("worker-a", 1);
      expect(claimed?.job.attempts).toBe(1);

      expect(repo.claim("worker-b", 1, new Date(Date.now() + 100))).toBeUndefined();
      expect(repo.get(enqueued.job.id)).toMatchObject({
        status: "dead_letter",
        attempts: 1,
        maxAttempts: 1,
      });
      expect(repo.db.prepare("SELECT reason,error,source FROM dead_letters WHERE job_id=?").get(enqueued.job.id)).toMatchObject({
        reason: "max_attempts",
        error: "max_attempts",
        source: "queue",
      });
      expect(repo.getIdempotencyRecord("crash-reclaim")).toMatchObject({
        status: "dead_letter",
        jobId: enqueued.job.id,
      });
    } finally {
      repo.close();
    }
  });
});

describe("durable Phase 2 result state", () => {
  it("commits canonical result and pending delivery atomically", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const enqueued = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      const claimed = repo.claim("worker-a", 1_000);
      repo.markRunning(enqueued.job.id, claimed!.fencingToken, {
        termination: "close",
        exitCode: 0,
        agentsSnapshotHash: "agents-hash",
        memorySnapshotHash: "memory-hash",
        toolCallKey: "tool-key",
      });
      const delivery = repo.commitResult(enqueued.job.id, claimed!.fencingToken, "canonical", {
        metadata: { timing: { promptMs: 10 } },
      });
      expect(repo.get(enqueued.job.id)).toMatchObject({
        status: "completed",
        resultJson: JSON.stringify("canonical"),
        succeeded: true,
        terminalState: "succeeded",
        agentsSnapshotHash: "agents-hash",
        toolCallKey: "tool-key",
      });
      expect(repo.getDelivery(enqueued.job.id)).toMatchObject({
        id: delivery.id,
        status: "pending",
        payloadJson: JSON.stringify("canonical"),
      });
    } finally {
      repo.close();
    }
  });

  it("enforces session ordering while allowing another session to claim", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const first = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "serial",
        content: "first",
        timestamp: new Date().toISOString(),
      });
      repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "serial",
        content: "second",
        timestamp: new Date().toISOString(),
      });
      const other = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "parallel",
        content: "other",
        timestamp: new Date().toISOString(),
      });
      const firstClaim = repo.claim("worker-a", 1_000);
      expect(firstClaim?.job.id).toBe(first.job.id);
      expect(repo.claim("worker-b", 1_000)?.job.id).toBe(other.job.id);
      expect(repo.get(first.job.id)?.sequence).toBe(0);
    } finally {
      repo.close();
    }
  });

  it("rejects stale result commits after lease fencing", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const job = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      const first = repo.claim("worker-a", 1);
      const second = repo.claim("worker-b", 1, new Date(Date.now() + 10));
      expect(second).toBeDefined();
      expect(() => repo.commitResult(job.job.id, first!.fencingToken, "stale")).toThrow(/stale fencing/);
    } finally {
      repo.close();
    }
  });
});
