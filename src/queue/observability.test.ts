import { describe, expect, it } from "vitest";
import { expectDefined } from "../test-utils.js";
import { collectObservability } from "./observability.js";
import { QueueRepository, openRuntimeDb } from "./repository.js";

describe("queue observability", () => {
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
