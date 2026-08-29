import { ChannelType } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renameSession = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../agent/session.js", () => ({ renameSession }));

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

function deliveryRow(payload: Record<string, unknown>) {
  return {
    id: "delivery-1",
    jobId: "job-1",
    status: "sending" as const,
    payloadJson: JSON.stringify(payload),
    createdAt: new Date().toISOString(),
  };
}

function enqueueLateItemThread(repo: QueueRepository, withConversationPath: boolean) {
  const enqueued = repo.enqueue({
    channelId: "channel",
    groupName: "group",
    sessionId: "cron-temp",
    content: "prompt",
    timestamp: new Date().toISOString(),
    cronJobId: "daily",
    cronDeliveryMode: "item-thread",
    cronSessionMode: "destination",
    cronThread: true,
    cronProvisioning: true,
  });
  const claim = repo.claim("agent", 60_000);
  if (!claim) throw new Error("expected claimed job");
  repo.markRunning(
    enqueued.job.id,
    claim.fencingToken,
    withConversationPath
      ? { conversationPath: "data/sessions/group/cron-temp.jsonl" }
      : {},
  );
  repo.commitResult(enqueued.job.id, claim.fencingToken, "response", {
    deliveryPayload: {
      groupName: "group",
      destinationType: "item-thread",
      destinationId: "channel",
      cronJobId: "daily",
    },
  });
  return enqueued.job.id;
}

describe("late item-thread delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    client.isReady.mockReturnValue(true);
    client.channels.cache.get.mockReturnValue(undefined);
  });

  it("rejects an ineligible destination before posting the parent response", async () => {
    const send = vi.fn();
    client.channels.fetch.mockResolvedValue({
      type: ChannelType.PublicThread,
      isSendable: () => true,
      send,
    });

    await expect(
      new DiscordDeliveryAdapter().send(
        deliveryRow({
          content: "response",
          groupName: "group",
          destinationType: "item-thread",
          destinationId: "channel",
          cronJobId: "daily",
        }),
      ),
    ).rejects.toMatchObject({ kind: "non-retryable" });
    expect(send).not.toHaveBeenCalled();
    expect(renameSession).not.toHaveBeenCalled();
  });

  it("updates the durable conversation path when the temporary session is promoted", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const jobId = enqueueLateItemThread(repo, true);
    const startThread = vi.fn().mockResolvedValue({ id: "123" });
    const send = vi.fn().mockResolvedValue({ id: "123", startThread });
    client.channels.fetch.mockResolvedValue({
      type: ChannelType.GuildText,
      isSendable: () => true,
      send,
    });

    try {
      const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
        ready: () => true,
      });
      await worker.runOnce();

      expect(renameSession).toHaveBeenCalledWith("group", "cron-temp", "123");
      expect(repo.get(jobId)).toMatchObject({
        sessionId: "123",
        conversationPath: "data/sessions/group/123.jsonl",
        cronThreadId: "123",
      });
      expect(startThread).toHaveBeenCalledOnce();
      expect(repo.getDelivery(jobId)).toMatchObject({
        status: "sent",
        cronThreadId: "123",
        externalMessageId: "123",
      });
    } finally {
      repo.close();
    }
  });

  it("keeps legacy promotion compatible when no conversation path was recorded", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const jobId = enqueueLateItemThread(repo, false);
    const startThread = vi.fn().mockResolvedValue({ id: "456" });
    client.channels.fetch.mockResolvedValue({
      type: ChannelType.GuildAnnouncement,
      isSendable: () => true,
      send: vi.fn().mockResolvedValue({ id: "456", startThread }),
    });

    try {
      const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
        ready: () => true,
      });
      await worker.runOnce();

      expect(repo.get(jobId)).toMatchObject({
        sessionId: "456",
        cronThreadId: "456",
      });
      expect(repo.get(jobId)?.conversationPath).toBeUndefined();
    } finally {
      repo.close();
    }
  });
});
