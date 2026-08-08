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
      repo.heartbeat(
        enqueued.job.id,
        expectDefined(claimed).fencingToken,
        10_000,
      );
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

describe("failAttempt - options object", () => {
  it("writes execution metadata to dedicated SQL columns instead of payload_json", () => {
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
      const timing = { promptMs: 10, dockerRunMs: 20, assistantTurns: 1 };
      repo.failAttempt(
        enqueued.job.id,
        new Error("boom"),
        expectDefined(claimed).fencingToken,
        {
          metadata: {
            exitCode: 1,
            termination: "close",
            stopReason: "error",
            timing,
          },
        },
      );
      const row = repo.db
        .prepare(
          "SELECT payload_json,exit_code,termination,stop_reason,timing_json FROM jobs WHERE id=?",
        )
        .get(enqueued.job.id) as {
        payload_json: string;
        exit_code: number | null;
        termination: string | null;
        stop_reason: string | null;
        timing_json: string | null;
      };
      // metadata lands in the execution-metadata columns, not in the payload
      expect(row.exit_code).toBe(1);
      expect(row.termination).toBe("close");
      expect(row.stop_reason).toBe("error");
      expect(row.timing_json).toBe(JSON.stringify(timing));
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("exitCode");
      expect(payload).not.toHaveProperty("termination");
      expect(payload).not.toHaveProperty("timing");
      expect(payload.retries).toBe(1);
    } finally {
      repo.close();
    }
  });

  it("never folds markRunning execution metadata into payload_json on failAttempt", () => {
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
      const token = expectDefined(claimed).fencingToken;
      const timing = { promptMs: 10, dockerRunMs: 20, assistantTurns: 1 };
      repo.markRunning(enqueued.job.id, token, {
        startedAt: "2025-01-01T00:00:00.000Z",
        workspacePath: "groups/group",
        conversationPath: "data/sessions/group/session.jsonl",
      });
      repo.failAttempt(enqueued.job.id, new Error("boom"), token, {
        metadata: {
          exitCode: 7,
          termination: "close",
          stopReason: "error",
          timing,
        },
      });
      const row = repo.db
        .prepare(
          "SELECT payload_json,claimed_at,started_at,heartbeat_at,workspace_path,conversation_path,exit_code,termination,stop_reason,timing_json FROM jobs WHERE id=?",
        )
        .get(enqueued.job.id) as {
        payload_json: string;
        claimed_at: string | null;
        started_at: string | null;
        heartbeat_at: string | null;
        workspace_path: string | null;
        conversation_path: string | null;
        exit_code: number | null;
        termination: string | null;
        stop_reason: string | null;
        timing_json: string | null;
      };
      // the running-attempt metadata lands in dedicated SQL columns ...
      expect(row.claimed_at).not.toBeNull();
      expect(row.started_at).toBe("2025-01-01T00:00:00.000Z");
      expect(row.heartbeat_at).not.toBeNull();
      expect(row.workspace_path).toBe("groups/group");
      expect(row.conversation_path).toBe("data/sessions/group/session.jsonl");
      expect(row.exit_code).toBe(7);
      expect(row.termination).toBe("close");
      expect(row.stop_reason).toBe("error");
      expect(row.timing_json).toBe(JSON.stringify(timing));
      // ... and none of it leaks into the persisted payload_json
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      for (const key of [
        "executionState",
        "claimedAt",
        "startedAt",
        "heartbeatAt",
        "workspacePath",
        "conversationPath",
        "exitCode",
        "termination",
        "stopReason",
        "timing",
      ]) {
        expect(payload).not.toHaveProperty(key);
      }
      // the domain payload survives intact
      expect(payload.id).toBe(enqueued.job.id);
      expect(payload.content).toBe("content");
      expect(payload.retries).toBe(1);
      // re-claimed job still surfaces metadata from the columns, not the payload
      const reClaimed = repo.claim(
        "worker-b",
        1_000,
        new Date(Date.now() + 100_000),
      );
      expect(reClaimed?.job.id).toBe(enqueued.job.id);
      expect(reClaimed?.job.workspacePath).toBe("groups/group");
      expect(reClaimed?.job.timing).toEqual(timing);
    } finally {
      repo.close();
    }
  });

  it("applies payloadPatch while keeping metadata out of payload_json", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const enqueued = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "original",
        timestamp: new Date().toISOString(),
      });
      const claimed = repo.claim("worker-a", 1_000);
      const token = expectDefined(claimed).fencingToken;
      repo.failAttempt(enqueued.job.id, new Error("boom"), token, {
        payloadPatch: { content: "patched" },
        metadata: { timing: { promptMs: 5 } },
      });
      const row = repo.db
        .prepare("SELECT payload_json,timing_json FROM jobs WHERE id=?")
        .get(enqueued.job.id) as {
        payload_json: string;
        timing_json: string | null;
      };
      const payload = JSON.parse(row.payload_json) as { content?: string };
      expect(payload.content).toBe("patched");
      expect(row.timing_json).toBe(JSON.stringify({ promptMs: 5 }));
      // re-claim after the retry wait to confirm both patch and metadata survive
      const reClaimed = repo.claim(
        "worker-b",
        1_000,
        new Date(Date.now() + 100_000),
      );
      expect(reClaimed?.job.id).toBe(enqueued.job.id);
      expect(reClaimed?.job.content).toBe("patched");
      expect(reClaimed?.job.timing).toEqual({ promptMs: 5 });
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
