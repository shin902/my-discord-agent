import { ChannelType } from "discord.js";
import { expect, it, vi } from "vitest";
import { openRuntimeDb, QueueRepository } from "../queue/repository.js";
import { enqueueCronInbox, provisionCronItemThread } from "./enqueue.js";

it("carries the noReply system-prompt option without changing content", async () => {
  const appendInbox = vi.fn();
  const base = {
    id: "job",
    client: {} as never,
    groupName: "group",
    channelId: "channel",
    deliveryMode: "direct" as const,
    sessionMode: "per-run" as const,
    appendInbox,
  };

  await enqueueCronInbox({ ...base, noReply: true }, "prompt");
  expect(appendInbox).toHaveBeenLastCalledWith(
    expect.objectContaining({ cronNoReply: true, content: "prompt" }),
  );

  await enqueueCronInbox(base, "prompt");
  expect(appendInbox).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ cronNoReply: expect.anything() }),
  );
});

it("provisions an item thread before the caller can run AI", async () => {
  const repository = new QueueRepository(openRuntimeDb(":memory:"));
  try {
    const job = repository.enqueue({
      channelId: "channel",
      groupName: "group",
      sessionId: "cron-item",
      content: "prompt",
      timestamp: new Date().toISOString(),
      cronDeliveryMode: "item-thread",
      cronSessionMode: "destination",
      cronThread: true,
      cronJobId: "item-job",
      cronProvisioning: true,
    }).job;
    const startThread = vi.fn().mockResolvedValue({ id: "thread-1" });
    const placeholder = { id: "placeholder-1", startThread };
    const parent = {
      type: ChannelType.GuildText,
      send: vi.fn().mockResolvedValue(placeholder),
    };
    const client = {
      channels: {
        fetch: vi.fn().mockResolvedValueOnce(parent),
      },
    } as never;

    await provisionCronItemThread(client, repository, job, {
      threadName: "item thread",
    });

    expect(parent.send).toHaveBeenCalledWith("処理中…");
    expect(startThread).toHaveBeenCalledWith({
      name: "item thread",
      autoArchiveDuration: expect.any(Number),
    });
    expect(repository.get(job.id)).toMatchObject({
      cronDeliveryMode: "item-thread",
      cronSessionMode: "destination",
      cronPlaceholderMessageId: "placeholder-1",
      cronThreadId: "thread-1",
      sessionId: "thread-1",
      cronProvisioning: false,
    });
  } finally {
    repository.close();
  }
});
