import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type ArticleDispatch,
  claimUnreadArticles,
  listUnreadArticles,
  openRssDb,
  saveFeedEntries,
} from "../rss/store.js";
import { expectDefined } from "../test-utils.js";
import { reconcileRssDispatches, settleRssDispatch } from "./reconciliation.js";
import { openRuntimeDb, QueueRepository } from "./repository.js";

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function makeRssPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rss-reconcile-test-"));
  tempDirs.push(dir);
  return join(dir, "custom-rss.sqlite3");
}

function seedUnread(path: string): void {
  const db = openRssDb(path);
  try {
    saveFeedEntries(db, {
      url: "https://example.com/feed.xml",
      parsedName: "Feed",
      etag: null,
      lastModified: null,
      entries: [
        {
          entryId: "article-1",
          title: "Article",
          link: "https://example.com/article",
          publishedAt: "2026-08-01",
          summary: "Summary",
        },
      ],
      markInitialAsRead: false,
    });
  } finally {
    db.close();
  }
}

function claimOne(path: string, owner: string): ArticleDispatch {
  const db = openRssDb(path);
  try {
    const dispatch = claimUnreadArticles(db, owner, 10);
    expect(dispatch).toBeDefined();
    return expectDefined(dispatch);
  } finally {
    db.close();
  }
}

function dispatchColumns(path: string): Array<{ dispatch_id: string | null; dispatch_job_id: string | null }> {
  const db = openRssDb(path);
  try {
    const row = z.object({ dispatch_id: z.string().nullable(), dispatch_job_id: z.string().nullable() });
    return z.array(row).parse(db.prepare("SELECT dispatch_id, dispatch_job_id FROM rss_articles ORDER BY id").all());
  } finally { db.close(); }
}

type QueuePayload = { channelId: string; groupName: string; sessionId: string; content: string; timestamp: string; rssDispatchId: string; rssStatePath: string };
function queuePayload(rssPath: string, dispatchId: string): QueuePayload {
  return {
    channelId: "channel",
    groupName: "rss",
    sessionId: "session",
    content: "content",
    timestamp: new Date().toISOString(),
    rssDispatchId: dispatchId,
    rssStatePath: rssPath,
  };
}

describe("reconcileRssDispatches", () => {
  it("startup recovery marks articles after the associated job completed", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const rssDb = openRssDb(rssPath);
      const dispatch = claimUnreadArticles(rssDb, "cron-rss", 10);
      expect(dispatch).toBeDefined();
      rssDb.close();
      const queued = repo.enqueue(
        {
          channelId: "channel",
          groupName: "rss",
          sessionId: "session",
          content: "content",
          timestamp: new Date().toISOString(),
          rssDispatchId: expectDefined(dispatch).id,
          rssStatePath: rssPath,
        },
        { idempotencyKey: expectDefined(dispatch).jobId },
      );
      const claimed = repo.claim("worker", 60_000);
      repo.commitResult(
        queued.job.id,
        expectDefined(claimed).fencingToken,
        "response",
        { deliveryPayload: { destinationId: "channel" } },
      );
      const deliveryClaim = repo.claimDelivery("delivery-worker");
      expect(deliveryClaim).toBeDefined();
      repo.updateDelivery(
        expectDefined(deliveryClaim).row.id,
        expectDefined(deliveryClaim).fencingToken,
        "sent",
      );

      const beforeRecovery = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(beforeRecovery, 10)).toHaveLength(1);
      } finally {
        beforeRecovery.close();
      }
      expect(reconcileRssDispatches(repo)).toBe(1);
      const check = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(check, 10)).toEqual([]);
      } finally {
        check.close();
      }
    } finally {
      repo.close();
    }
  });

  it("releases a claimed RSS dispatch after a completed job has failed delivery", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "failed");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.commitResult(
        queued.job.id,
        expectDefined(claimed).fencingToken,
        "response",
        { deliveryPayload: { destinationId: "channel" } },
      );
      const deliveryClaim = repo.claimDelivery("delivery-worker");
      repo.updateDelivery(
        expectDefined(deliveryClaim).row.id,
        expectDefined(deliveryClaim).fencingToken,
        "failed",
      );

      expect(reconcileRssDispatches(repo, rssPath)).toBe(1);
      expect(dispatchColumns(rssPath)[0]?.dispatch_id).toBeNull();
      const check = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(check, 10)).toHaveLength(1);
      } finally {
        check.close();
      }
    } finally {
      repo.close();
    }
  });

  it("releases a completed multi-chunk RSS dispatch when terminal chunks include failures", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "failed-chunks");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.commitResult(
        queued.job.id,
        expectDefined(claimed).fencingToken,
        "x".repeat(4001),
        { deliveryPayload: { destinationId: "channel" } },
      );
      let deliveryClaim = repo.claimDelivery("delivery-worker");
      expect(deliveryClaim).toBeDefined();
      repo.updateDelivery(
        expectDefined(deliveryClaim).row.id,
        expectDefined(deliveryClaim).fencingToken,
        "sent",
      );
      deliveryClaim = repo.claimDelivery("delivery-worker");
      while (deliveryClaim) {
        repo.updateDelivery(
          deliveryClaim.row.id,
          deliveryClaim.fencingToken,
          "failed",
        );
        deliveryClaim = repo.claimDelivery("delivery-worker");
      }

      expect(reconcileRssDispatches(repo, rssPath)).toBe(1);
      expect(dispatchColumns(rssPath)[0]?.dispatch_id).toBeNull();
      const check = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(check, 10)).toHaveLength(1);
      } finally {
        check.close();
      }
    } finally {
      repo.close();
    }
  });

  it("keeps a claimed RSS dispatch unread when a delivery chunk is pending", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "pending");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.commitResult(
        queued.job.id,
        expectDefined(claimed).fencingToken,
        "x".repeat(4001),
        {
          deliveryPayload: { destinationId: "channel" },
        },
      );
      const deliveryClaim = repo.claimDelivery("delivery-worker");
      repo.updateDelivery(
        expectDefined(deliveryClaim).row.id,
        expectDefined(deliveryClaim).fencingToken,
        "sent",
      );
      expect(reconcileRssDispatches(repo, rssPath)).toBe(0);
      expect(dispatchColumns(rssPath)[0]?.dispatch_id).toBe(dispatch.id);
    } finally {
      repo.close();
    }
  });

  it("keeps a claimed RSS dispatch unread when the completed job has no delivery", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "missing-delivery");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.complete(queued.job.id, expectDefined(claimed).fencingToken);
      expect(reconcileRssDispatches(repo, rssPath)).toBe(0);
      expect(dispatchColumns(rssPath)[0]?.dispatch_id).toBe(dispatch.id);
    } finally {
      repo.close();
    }
  });

  it("marks a claimed RSS dispatch read only after every delivery is sent", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "all-sent");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.commitResult(
        queued.job.id,
        expectDefined(claimed).fencingToken,
        "x".repeat(4001),
        {
          deliveryPayload: { destinationId: "channel" },
        },
      );
      let deliveryClaim = repo.claimDelivery("delivery-worker");
      while (deliveryClaim) {
        repo.updateDelivery(
          deliveryClaim.row.id,
          deliveryClaim.fencingToken,
          "sent",
        );
        deliveryClaim = repo.claimDelivery("delivery-worker");
      }
      expect(reconcileRssDispatches(repo, rssPath)).toBe(1);
      expect(dispatchColumns(rssPath)[0]?.dispatch_id).toBeNull();
    } finally {
      repo.close();
    }
  });

  it("settles only the targeted RSS dispatch", async () => {
    const completedPath = await makeRssPath();
    const pendingPath = await makeRssPath();
    seedUnread(completedPath);
    seedUnread(pendingPath);
    const completedDispatch = claimOne(completedPath, "completed");
    const pendingDispatch = claimOne(pendingPath, "pending");

    expect(
      settleRssDispatch(
        completedPath,
        completedDispatch.id,
        completedDispatch.jobId,
        "completed",
      ),
    ).toBe(1);
    const completedCheck = openRssDb(completedPath);
    const pendingCheck = openRssDb(pendingPath);
    try {
      expect(listUnreadArticles(completedCheck, 10)).toEqual([]);
      expect(listUnreadArticles(pendingCheck, 10)).toHaveLength(1);
    } finally {
      completedCheck.close();
      pendingCheck.close();
    }
    expect(pendingDispatch.articles).toHaveLength(1);
  });

  it("converges reads from a completed idempotency tombstone without a jobs row", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const rssDb = openRssDb(rssPath);
      const dispatch = claimUnreadArticles(rssDb, "cron-rss", 10);
      rssDb.close();
      const completedAt = new Date().toISOString();
      repo.db
        .prepare(
          "INSERT INTO idempotency_keys(key,job_id,status,created_at,completed_at) VALUES(?,?,?,?,?)",
        )
        .run(
          expectDefined(dispatch).jobId,
          null,
          "completed",
          completedAt,
          completedAt,
        );

      expect(reconcileRssDispatches(repo, rssPath)).toBe(0);
      const check = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(check, 10)).toHaveLength(1);
      } finally {
        check.close();
      }
    } finally {
      repo.close();
    }
  });

  it("does not re-scan queue payloads when the caller supplies paths", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    claimOne(rssPath, "cron-supplied");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const discoverySpy = vi.spyOn(repo, "listRssStatePaths");
      expect(reconcileRssDispatches(repo, [rssPath])).toBe(1);
      expect(discoverySpy).not.toHaveBeenCalled();
    } finally {
      repo.close();
    }
  });

  it("uses caller-supplied paths as authoritative (same path, deduplicated)", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "cron-rss");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.complete(queued.job.id, expectDefined(claimed).fencingToken);
      // The same path is passed twice; it must be opened and reconciled exactly once.
      expect(reconcileRssDispatches(repo, [rssPath, rssPath])).toBe(0);
    } finally {
      repo.close();
    }
  });

  it("releases claims whose job never reached the queue", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    claimOne(rssPath, "cron-rss");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      expect(reconcileRssDispatches(repo, rssPath)).toBe(1);
      expect(dispatchColumns(rssPath)).toEqual([
        { dispatch_id: null, dispatch_job_id: null },
      ]);
      const check = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(check, 10)).toHaveLength(1);
      } finally {
        check.close();
      }
    } finally {
      repo.close();
    }
  });

  it("keeps claims during retry failure and releases them after dead-letter", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "cron-rss");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
        maxAttempts: 2,
      });
      const firstClaimed = repo.claim("worker", 60_000);
      repo.failAttempt(
        queued.job.id,
        new Error("temporary failure"),
        expectDefined(firstClaimed).fencingToken,
      );

      expect(repo.get(queued.job.id)).toMatchObject({ status: "retry_wait" });
      expect(dispatchColumns(rssPath)).toEqual([
        {
          dispatch_id: dispatch.id,
          dispatch_job_id: dispatch.jobId,
        },
      ]);
      const duringRetry = openRssDb(rssPath);
      try {
        expect(listUnreadArticles(duringRetry, 10)).toHaveLength(1);
      } finally {
        duringRetry.close();
      }

      const secondClaimed = repo.claim(
        "worker",
        60_000,
        new Date(Date.now() + 120_000),
      );
      repo.deadLetter(
        queued.job.id,
        expectDefined(secondClaimed).fencingToken,
        "non_retryable",
      );
      expect(repo.get(queued.job.id)).toMatchObject({ status: "dead_letter" });
      expect(
        settleRssDispatch(rssPath, dispatch.id, dispatch.jobId, "dead_letter"),
      ).toBe(1);
      expect(dispatchColumns(rssPath)).toEqual([
        { dispatch_id: null, dispatch_job_id: null },
      ]);
    } finally {
      repo.close();
    }
  });

  it("releases claims for dead-lettered jobs", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "cron-rss");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.deadLetter(
        queued.job.id,
        expectDefined(claimed).fencingToken,
        "non_retryable",
      );

      expect(reconcileRssDispatches(repo, rssPath)).toBe(1);
      expect(dispatchColumns(rssPath)).toEqual([
        { dispatch_id: null, dispatch_job_id: null },
      ]);
    } finally {
      repo.close();
    }
  });

  it("reconciles completed, dead-lettered, and missing jobs across multiple databases", async () => {
    const completedPath = await makeRssPath();
    const deadLetterPath = await makeRssPath();
    const missingPath = await makeRssPath();
    seedUnread(completedPath);
    seedUnread(deadLetterPath);
    seedUnread(missingPath);
    const completedDispatch = claimOne(completedPath, "cron-rss");
    const deadDispatch = claimOne(deadLetterPath, "cron-rss");
    claimOne(missingPath, "cron-rss"); // never enqueued
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const completedQueued = repo.enqueue(
        queuePayload(completedPath, completedDispatch.id),
        { idempotencyKey: completedDispatch.jobId },
      );
      const completedClaimed = repo.claim("worker", 60_000);
      repo.complete(
        completedQueued.job.id,
        expectDefined(completedClaimed).fencingToken,
      );

      const deadQueued = repo.enqueue(
        queuePayload(deadLetterPath, deadDispatch.id),
        {
          idempotencyKey: deadDispatch.jobId,
        },
      );
      const deadClaimed = repo.claim("worker", 60_000);
      repo.deadLetter(
        deadQueued.job.id,
        expectDefined(deadClaimed).fencingToken,
        "non_retryable",
      );

      expect(
        reconcileRssDispatches(repo, [
          completedPath,
          deadLetterPath,
          missingPath,
        ]),
      ).toBe(2);
      const completedCheck = openRssDb(completedPath);
      try {
        expect(listUnreadArticles(completedCheck, 10)).toHaveLength(1);
      } finally {
        completedCheck.close();
      }
      expect(dispatchColumns(deadLetterPath)).toEqual([
        { dispatch_id: null, dispatch_job_id: null },
      ]);
      expect(dispatchColumns(missingPath)).toEqual([
        { dispatch_id: null, dispatch_job_id: null },
      ]);
    } finally {
      repo.close();
    }
  });

  it("keeps standalone queue-payload discovery when no paths are supplied", async () => {
    const rssPath = await makeRssPath();
    seedUnread(rssPath);
    const dispatch = claimOne(rssPath, "cron-rss");
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const queued = repo.enqueue(queuePayload(rssPath, dispatch.id), {
        idempotencyKey: dispatch.jobId,
      });
      const claimed = repo.claim("worker", 60_000);
      repo.complete(queued.job.id, expectDefined(claimed).fencingToken);

      const discoverySpy = vi.spyOn(repo, "listRssStatePaths");
      expect(reconcileRssDispatches(repo)).toBe(0);
      expect(discoverySpy).toHaveBeenCalledTimes(1);
    } finally {
      repo.close();
    }
  });
});
