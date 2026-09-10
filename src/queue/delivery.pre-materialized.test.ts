import { beforeEach, describe, expect, it, vi } from "vitest";

const renameSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../agent/session.js", () => ({
  renameSession,
  sessionConversationPath: (groupName: string, sessionId: string) =>
    `data/sessions/${groupName}/sessions.sqlite#session=${sessionId}`,
}));

const acknowledgeEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../cron/mail-ack.js", () => ({ acknowledgeEmail }));

const settleRssDispatch = vi.hoisted(() => vi.fn());
vi.mock("./reconciliation.js", () => ({ settleRssDispatch }));

const client = vi.hoisted(() => ({
  isReady: vi.fn().mockReturnValue(true),
  channels: {
    cache: { get: vi.fn() },
    fetch: vi.fn(),
  },
}));
vi.mock("../discord/client.js", () => ({
  getDiscordClientForGroupName: vi.fn().mockResolvedValue(client),
  getDiscordClients: () => new Map([["group", client]]),
}));

import { DeliveryWorker, DiscordDeliveryAdapter } from "./delivery.js";
import { openRuntimeDb, QueueRepository } from "./repository.js";

function expectDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected value");
  return value;
}

describe("pre-materialized item-thread compatibility removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.isReady.mockReturnValue(true);
    client.channels.cache.get.mockReturnValue(undefined);
  });

  it("does not deliver legacy overflow chunks after the placeholder chunk was already sent", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const enqueued = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "thread-old",
        content: "prompt",
        timestamp: new Date().toISOString(),
        cronJobId: "daily",
        cronDeliveryMode: "item-thread",
        cronSessionMode: "destination",
        cronThread: true,
        cronProvisioning: false,
        cronThreadId: "thread-old",
        cronPlaceholderMessageId: "placeholder-old",
      });
      const agentClaim = expectDefined(repo.claim("agent", 60_000));
      repo.commitResult(
        enqueued.job.id,
        agentClaim.fencingToken,
        "x".repeat(4001),
        {
          deliveryPayload: {
            groupName: "group",
            destinationType: "new-thread",
            destinationId: "channel",
            cronJobId: "daily",
            cronThreadId: "thread-old",
            cronPlaceholderMessageId: "placeholder-old",
          },
        },
      );

      const deliveries = repo.listDeliveries();
      expect(deliveries).toHaveLength(3);
      expect(JSON.parse(deliveries[0]?.payloadJson ?? "{}")).toMatchObject({
        cronPlaceholderMessageId: "placeholder-old",
      });
      expect(JSON.parse(deliveries[1]?.payloadJson ?? "{}")).not.toHaveProperty(
        "cronPlaceholderMessageId",
      );

      const first = expectDefined(repo.claimDelivery("old-runtime"));
      repo.updateDelivery(first.row.id, first.fencingToken, "sent", {
        externalMessageId: "placeholder-old",
        cronThreadId: "thread-old",
      });

      const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
        workerId: "new-runtime",
        ready: () => true,
      });
      await worker.runOnce();

      expect(client.channels.fetch).not.toHaveBeenCalled();
      expect(
        repo
          .listDeliveries()
          .filter((delivery) => delivery.jobId === enqueued.job.id)
          .map((delivery) => delivery.status),
      ).toEqual(["sent", "failed", "failed"]);
    } finally {
      repo.close();
    }
  });
});
