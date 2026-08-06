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
