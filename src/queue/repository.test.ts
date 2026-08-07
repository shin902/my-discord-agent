import { describe, expect, it } from "vitest";
import { expectDefined } from "../test-utils.js";
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
      repo.renew(enqueued.job.id, expectDefined(claimed).fencingToken, 10_000);
      const later = new Date(Date.now() + 500).toISOString();
      expect(repo.claim("worker-b", 100, new Date(later))).toBeUndefined();
    } finally {
      repo.close();
    }
  });

  it("dead-letters an expired lease at max attempts before reclaiming it", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const enqueued = repo.enqueue(
        {
          channelId: "channel",
          groupName: "group",
          sessionId: "session",
          content: "content",
          timestamp: new Date().toISOString(),
        },
        { idempotencyKey: "crash-reclaim", maxAttempts: 1 },
      );
      const claimed = repo.claim("worker-a", 1);
      expect(claimed?.job.attempts).toBe(1);

      expect(
        repo.claim("worker-b", 1, new Date(Date.now() + 100)),
      ).toBeUndefined();
      expect(repo.get(enqueued.job.id)).toMatchObject({
        status: "dead_letter",
        attempts: 1,
        maxAttempts: 1,
      });
      expect(
        repo.db
          .prepare(
            "SELECT reason,error,source FROM dead_letters WHERE job_id=?",
          )
          .get(enqueued.job.id),
      ).toMatchObject({
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
      repo.markRunning(enqueued.job.id, expectDefined(claimed).fencingToken, {
        termination: "close",
        exitCode: 0,
        agentsSnapshotHash: "agents-hash",
        memorySnapshotHash: "memory-hash",
        toolCallKey: "tool-key",
      });
      const delivery = repo.commitResult(
        enqueued.job.id,
        expectDefined(claimed).fencingToken,
        "canonical",
        {
          metadata: { timing: { promptMs: 10 } },
        },
      );
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

  it("claims only the lowest eligible chunk per job while allowing other jobs to proceed", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const firstJob = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session-a",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      const firstClaim = repo.claim("worker-a", 1_000);
      const firstDelivery = repo.commitResult(
        firstJob.job.id,
        expectDefined(firstClaim).fencingToken,
        "a".repeat(2_001),
        {
          deliveryPayload: {
            destinationType: "channel",
            destinationId: "channel",
          },
        },
      );
      const firstChunks = repo
        .listDeliveries()
        .filter((row) => row.jobId === firstJob.job.id);
      expect(firstChunks).toHaveLength(2);
      repo.db
        .prepare(
          "UPDATE deliveries SET status='retry_wait',next_attempt_at=?,lease_until=?,worker_id=? WHERE id=?",
        )
        .run(
          new Date(0).toISOString(),
          new Date(0).toISOString(),
          "stale-worker",
          firstDelivery.id,
        );

      const secondJob = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session-b",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      const secondClaim = repo.claim("worker-b", 1_000);
      const secondDelivery = repo.commitResult(
        secondJob.job.id,
        expectDefined(secondClaim).fencingToken,
        "second",
        {
          deliveryPayload: {
            destinationType: "channel",
            destinationId: "channel",
          },
        },
      );
      const claimed = repo.claimDelivery("delivery-worker", 1_000, new Date());
      expect(claimed?.row.id).toBe(firstDelivery.id);
      expect(claimed?.row.responseIndex).toBe(0);
      expect(
        repo
          .listDeliveries()
          .find((row) => row.id === expectDefined(firstChunks[1]).id)?.status,
      ).toBe("pending");
      expect(
        repo.listDeliveries().find((row) => row.id === secondDelivery.id)
          ?.status,
      ).toBe("pending");
      expect(
        repo.claimDelivery("delivery-worker-2", 1_000, new Date())?.row.id,
      ).toBe(secondDelivery.id);
    } finally {
      repo.close();
    }
  });

  it("clears delivery lease metadata when retrying with an explicit retry time", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const job = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
      });
      const claimedJob = repo.claim("worker-a", 1_000);
      const delivery = repo.commitResult(
        job.job.id,
        expectDefined(claimedJob).fencingToken,
        "response",
        {
          deliveryPayload: {
            destinationType: "channel",
            destinationId: "channel",
          },
        },
      );
      const claimedDelivery = expectDefined(
        repo.claimDelivery("worker-a", 1_000),
      );
      repo.updateDelivery(
        delivery.id,
        claimedDelivery.fencingToken,
        "retry_wait",
        {
          error: "temporary",
          retryAt: new Date(Date.now() + 10_000).toISOString(),
        },
      );
      const row = repo.db
        .prepare(
          "SELECT status,lease_until,worker_id,next_attempt_at FROM deliveries WHERE id=?",
        )
        .get(delivery.id) as Record<string, unknown>;
      expect(row).toMatchObject({
        status: "retry_wait",
        lease_until: null,
        worker_id: null,
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
      expect(() =>
        repo.commitResult(
          job.job.id,
          expectDefined(first).fencingToken,
          "stale",
        ),
      ).toThrow(/stale fencing/);
    } finally {
      repo.close();
    }
  });
});
