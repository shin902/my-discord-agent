import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  repository: undefined as unknown,
}));

vi.mock("../../queue/repository.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../queue/repository.js")
  >("../../queue/repository.js");
  return {
    ...actual,
    getQueueRepository: () => state.repository,
  };
});

import { reconcileRssDispatches } from "../../queue/reconciliation.js";
import { QueueRepository } from "../../queue/repository.js";
import type { QueueInput } from "../../queue/types.js";
import {
  claimUnreadArticles,
  listDispatchClaims,
  listUnreadArticles,
  openRssDb,
  saveFeedEntries,
} from "../../rss/store.js";
import type { CronContext } from "../runner.js";
import dispatchHandler from "./rss-dispatch.js";

let tmpDir: string;
let statePath: string;
let repository: QueueRepository;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rss-item-thread-dispatch-test-"));
  statePath = join(tmpDir, "rss.sqlite3");
  repository = new QueueRepository(join(tmpDir, "runtime.sqlite"));
  state.repository = repository;
});

afterEach(async () => {
  repository.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("RSS item-thread dispatch identity", () => {
  it("keeps the source identity through queue delivery and restart reconciliation", async () => {
    const rssDb = openRssDb(statePath);
    saveFeedEntries(rssDb, {
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
    rssDb.close();

    const appendInbox = vi.fn(async (payload: QueueInput) => {
      repository.enqueue(payload);
    });
    const ctx: CronContext = {
      id: "rss-dispatch",
      schedule: "15m",
      enabled: true,
      handler: "jobs/rss-dispatch.ts",
      groupName: "rss",
      prompt: "RSS記事を要約してください",
      channelId: "channel",
      deliveryMode: "item-thread",
      sessionMode: "destination",
      settings: { statePath },
      client: {} as CronContext["client"],
      appendInbox,
    };

    await dispatchHandler(ctx);

    const claimedRssDb = openRssDb(statePath);
    const dispatch = listDispatchClaims(claimedRssDb)[0];
    claimedRssDb.close();
    if (!dispatch) throw new Error("expected RSS dispatch claim");

    const job = repository.findByIdempotencyKey(dispatch.dispatchJobId);
    expect(job).toMatchObject({
      idempotencyKey: dispatch.dispatchJobId,
      rssDispatchId: dispatch.dispatchId,
      rssStatePath: statePath,
      cronDeliveryMode: "item-thread",
      cronSessionMode: "destination",
      cronProvisioning: true,
    });
    expect(job?.sessionId).toMatch(/^cron-rss-dispatch-/);
    expect(appendInbox).toHaveBeenCalledOnce();

    const claim = repository.claim("poller");
    if (!claim || !job) throw new Error("expected queued RSS item-thread job");
    repository.commitResult(job.id, claim.fencingToken, "response", {
      deliveryPayload: {
        groupName: job.groupName,
        destinationType: "item-thread",
        destinationId: job.channelId,
        cronJobId: job.cronJobId,
        rssDispatchId: job.rssDispatchId,
        rssStatePath: job.rssStatePath,
        rssDispatchJobId: job.idempotencyKey,
      },
    });

    const deliveryClaim = repository.claimDelivery("delivery-worker");
    if (!deliveryClaim) throw new Error("expected RSS delivery");
    repository.updateDelivery(
      deliveryClaim.row.id,
      deliveryClaim.fencingToken,
      "sent",
    );

    const delivery = repository.listDeliveries()[0];
    expect(delivery).toBeDefined();
    expect(JSON.parse(delivery?.payloadJson ?? "{}")).toMatchObject({
      destinationType: "item-thread",
      rssDispatchId: dispatch.dispatchId,
      rssStatePath: statePath,
      rssDispatchJobId: dispatch.dispatchJobId,
    });

    repository.close();
    repository = new QueueRepository(join(tmpDir, "runtime.sqlite"));
    state.repository = repository;

    expect(reconcileRssDispatches(repository, statePath)).toBe(1);
    const reconciledRssDb = openRssDb(statePath);
    try {
      expect(listDispatchClaims(reconciledRssDb)).toEqual([]);
      expect(listUnreadArticles(reconciledRssDb, 10)).toEqual([]);
      expect(
        claimUnreadArticles(reconciledRssDb, "rss-dispatch", 10),
      ).toBeUndefined();
    } finally {
      reconciledRssDb.close();
    }
  });
});
