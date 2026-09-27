import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerRssSource } from "../features/rss.js";
import {
  claimUnreadArticles,
  listDispatchClaims,
  listUnreadArticles,
  openRssDb,
  saveFeedEntries,
} from "../rss/store.js";
import { expectDefined } from "../test-utils.js";
import {
  type DeliveryAdapter,
  DeliveryError,
  DeliveryWorker,
} from "./delivery.js";
import { QueueRepository } from "./repository.js";
import { SourceHandlers } from "./source-handlers.js";

describe("registered RSS source lifecycle", () => {
  it("does not send a persisted delivery with an unregistered source", async () => {
    const repo = new QueueRepository(":memory:");
    try {
      const job = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "prompt",
        timestamp: new Date().toISOString(),
      }).job;
      const claim = expectDefined(repo.claim());
      repo.commitResult(job.id, claim.fencingToken, "response", {
        deliveryPayload: {
          destinationId: "channel",
          feature: { kind: "unknown", input: {} },
        },
      });
      const send = vi.fn(async () => ({ externalMessageId: "sent" }));
      const worker = new DeliveryWorker(
        repo,
        { send },
        {},
        new SourceHandlers(),
      );
      await worker.runOnce();
      expect(send).not.toHaveBeenCalled();
      expect(repo.listDeliveries().map((row) => row.status)).toEqual([
        "failed",
      ]);
    } finally {
      repo.close();
    }
  });

  it("uses persisted delivery policy, not JSON inspection, to pass a failed predecessor", () => {
    const repo = new QueueRepository(":memory:");
    const sources = new SourceHandlers();
    registerRssSource(sources, repo);
    repo.registerSources(sources);
    try {
      const payload = {
        channelId: "channel",
        groupName: "group",
        sessionId: "rss-session",
        content: "prompt",
        timestamp: new Date().toISOString(),
        feature: { kind: "rss", input: { dispatchId: "dispatch" } },
      };
      const job = repo.enqueue(payload).job;
      const claimed = expectDefined(repo.claim());
      repo.commitResult(job.id, claimed.fencingToken, "x".repeat(2001), {
        deliveryPayload: { destinationId: "channel", feature: payload.feature },
      });
      const first = expectDefined(repo.claimDelivery("worker-a"));
      repo.updateDelivery(first.row.id, first.fencingToken, "failed");
      expect(repo.claimDelivery("worker-b")?.row.responseIndex).toBe(1);
      expect(
        repo.db
          .prepare("SELECT allow_failed_predecessor FROM jobs WHERE id=?")
          .get(job.id),
      ).toEqual({ allow_failed_predecessor: 1 });
    } finally {
      repo.close();
    }
  });

  it.each([
    false,
    true,
  ])("settles a multi-chunk dispatch after delivery (second chunk fails: %s)", async (fail) => {
    const dir = await mkdtemp(join(tmpdir(), "source-rss-"));
    const rssPath = join(dir, "rss.sqlite3");
    const repo = new QueueRepository(join(dir, "runtime.sqlite"));
    const sources = new SourceHandlers();
    registerRssSource(sources, repo);
    repo.registerSources(sources);
    try {
      const db = openRssDb(rssPath);
      saveFeedEntries(db, {
        url: "https://example.com/rss",
        parsedName: "Feed",
        etag: null,
        lastModified: null,
        markInitialAsRead: false,
        entries: [
          {
            entryId: "one",
            title: "One",
            link: "https://example.com/one",
            publishedAt: "",
            summary: "",
          },
        ],
      });
      const dispatch = expectDefined(claimUnreadArticles(db, "rss-owner", 1));
      db.close();
      const feature = {
        kind: "rss",
        input: {
          dispatchId: dispatch.id,
          dispatchJobId: dispatch.jobId,
          statePath: rssPath,
        },
      };
      const job = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "prompt",
        timestamp: new Date().toISOString(),
        idempotencyKey: dispatch.jobId,
        feature,
      }).job;
      const claim = expectDefined(repo.claim());
      repo.commitResult(job.id, claim.fencingToken, "x".repeat(4001), {
        deliveryPayload: {
          destinationType: "channel",
          destinationId: "channel",
          feature,
        },
      });
      let calls = 0;
      const adapter: DeliveryAdapter = {
        send: vi.fn(async () => {
          calls += 1;
          if (fail && calls === 2) throw new DeliveryError("retryable", "429");
          return { externalMessageId: `sent-${calls}` };
        }),
      };
      const worker = new DeliveryWorker(repo, adapter, {}, sources);
      await worker.runOnce();
      const before = openRssDb(rssPath);
      expect(listDispatchClaims(before)).toHaveLength(1);
      before.close();
      await worker.runOnce();
      if (!fail) await worker.runOnce();
      const after = openRssDb(rssPath);
      expect(listDispatchClaims(after)).toHaveLength(0);
      expect(listUnreadArticles(after, 10)).toHaveLength(fail ? 1 : 0);
      after.close();
      expect(repo.listDeliveries().map((row) => row.status)).toEqual(
        fail ? ["sent", "failed", "failed"] : ["sent", "sent", "sent"],
      );
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
