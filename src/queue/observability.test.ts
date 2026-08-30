import { describe, expect, it } from "vitest";
import { expectDefined } from "../test-utils.js";
import { collectObservability, inspectRuntime } from "./observability.js";
import { openRuntimeDb, QueueRepository } from "./repository.js";

describe("queue observability", () => {
  it("does not count a successful suppressed shadow job as an empty response", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const shadow = repo.enqueue({
        channelId: "c",
        groupName: "g",
        sessionId: "memory-shadow:s",
        content: "memory-shadow",
        timestamp: new Date().toISOString(),
        memoryShadow: {
          scope: {
            teamId: "team",
            agentId: "agent",
            userId: "user",
            sessionId: "s",
          },
          messages: [],
        },
      }).job;
      const claim = expectDefined(repo.claim("worker", 1_000));
      repo.commitResult(shadow.id, claim.fencingToken, "", {
        suppressDelivery: true,
      });

      const snapshot = collectObservability(repo.db);
      expect(snapshot.agent).toMatchObject({
        jobs: 1,
        completed: 1,
        failed: 0,
        emptyResponses: 0,
      });
    } finally {
      repo.close();
    }
  });

  it("excludes admission tickets from queue and agent observability", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const at = new Date("2025-01-01T00:00:00.000Z");
    const createdAt = at.toISOString();
    try {
      const completed = repo.enqueue({
        channelId: "c",
        groupName: "g",
        sessionId: "real-completed",
        content: "completed",
        timestamp: createdAt,
      }).job;
      const failed = repo.enqueue({
        channelId: "c",
        groupName: "g",
        sessionId: "real-failed",
        content: "failed",
        timestamp: createdAt,
      }).job;
      const setTerminal = (
        id: string,
        status: "completed" | "dead_letter",
        attempts: number,
        completedAt: string,
      ) => {
        repo.db
          .prepare(
            "UPDATE jobs SET status=?,attempts=?,created_at=?,completed_at=?,updated_at=?,result_state=? WHERE id=?",
          )
          .run(
            status,
            attempts,
            createdAt,
            completedAt,
            completedAt,
            status === "dead_letter" ? "non_retryable" : "succeeded",
            id,
          );
      };
      setTerminal(completed.id, "completed", 2, "2025-01-01T00:00:10.000Z");
      setTerminal(failed.id, "dead_letter", 3, "2025-01-01T00:00:10.000Z");

      const admissionIds = ["successful", "failed", "cancelled", "active"].map(
        (name) =>
          repo.createBotTaskSessionAndAdmission({
            sessionId: `bot-task-${name}`,
            handle: `task-${name}`,
            groupName: "g",
            botId: "coding",
            createdAt,
            preview: name,
          }).admission.jobId,
      );
      for (const [index, id] of admissionIds.entries()) {
        repo.db
          .prepare(
            "UPDATE jobs SET status=?,attempts=?,created_at=?,completed_at=?,updated_at=?,result_state=?,terminal_reason=?,lease_until=? WHERE id=?",
          )
          .run(
            index === 0 ? "completed" : index === 3 ? "running" : "dead_letter",
            100 + index,
            createdAt,
            index === 3 ? null : "2025-01-01T00:00:10.000Z",
            "2025-01-01T00:00:10.000Z",
            index === 0
              ? "succeeded"
              : index === 1
                ? "non_retryable"
                : index === 2
                  ? "dead_letter"
                  : null,
            index === 2 ? "cancelled" : null,
            index === 3 ? "2024-12-31T23:59:59.000Z" : null,
            id,
          );
      }

      const snapshot = collectObservability(repo.db, undefined, { at });
      expect(snapshot.queue.byStatus).toEqual({
        completed: 1,
        dead_letter: 1,
      });
      expect(snapshot.queue.latencyMs).toEqual({
        count: 2,
        p50: 10_000,
        p95: 10_000,
        p99: 10_000,
      });
      expect(snapshot.queue.staleClaims).toBe(0);
      expect(snapshot.agent).toMatchObject({
        jobs: 2,
        completed: 1,
        failed: 1,
        emptyResponses: 0,
        averageAttempts: 2.5,
      });

      const inspection = inspectRuntime(repo.db);
      expect(inspection.jobs).toHaveLength(2);
      expect(inspection.jobs.map((job) => job.id)).toEqual(
        expect.arrayContaining([completed.id, failed.id]),
      );
      expect(
        repo.db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
      ).toEqual({ count: 6 });
    } finally {
      repo.close();
    }
  });

  it("counts only claims older than the requested stale threshold and reports it", () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const at = new Date("2025-01-01T00:00:00.000Z");
    try {
      const job = repo.enqueue({
        channelId: "c",
        groupName: "g",
        sessionId: "s",
        content: "hello",
        timestamp: at.toISOString(),
      }).job;
      const claim = repo.claim("worker", 60_000, at);
      expect(claim?.job.id).toBe(job.id);
      repo.commitResult(job.id, expectDefined(claim).fencingToken, "done");
      repo.db
        .prepare("UPDATE jobs SET status='running',lease_until=? WHERE id=?")
        .run("2024-12-31T23:59:59.000Z", job.id);
      repo.db
        .prepare(
          "UPDATE deliveries SET status='sending',lease_until=? WHERE job_id=?",
        )
        .run("2024-12-31T23:59:59.000Z", job.id);

      const recent = collectObservability(repo.db, undefined, {
        at,
        staleAfterMs: 2_000,
      });
      expect(recent.queue.staleClaims).toBe(0);
      expect(recent.delivery.staleClaims).toBe(0);

      const stale = collectObservability(repo.db, undefined, {
        at,
        staleAfterMs: 500,
      });
      expect(stale.queue.staleClaims).toBe(1);
      expect(stale.delivery.staleClaims).toBe(1);
      expect(stale.alerts).toContain(
        "stale queue claims (lease expired > 500ms): 1",
      );
      expect(stale.alerts).toContain(
        "stale delivery claims (lease expired > 500ms): 1",
      );
    } finally {
      repo.close();
    }
  });
});
