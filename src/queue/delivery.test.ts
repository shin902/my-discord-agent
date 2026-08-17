import { describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  isReady: vi.fn().mockReturnValue(false),
  channels: {
    cache: { get: vi.fn() },
    fetch: vi.fn(),
  },
}));
vi.mock("../discord/client.js", () => ({
  getDiscordClientForGroupName: vi.fn().mockResolvedValue(client),
  getDiscordClients: () => new Map([["personal", client]]),
}));

import { expectDefined } from "../test-utils.js";
import {
  type DeliveryAdapter,
  DeliveryError,
  DeliveryWorker,
  DiscordDeliveryAdapter,
} from "./delivery.js";
import { openRuntimeDb, QueueRepository } from "./repository.js";

function completed(
  repo: QueueRepository,
  response: string,
  metadata: Record<string, unknown> = {},
) {
  const item = repo.enqueue({
    channelId: "channel",
    groupName: "group",
    sessionId: "session",
    content: "prompt",
    timestamp: new Date().toISOString(),
  });
  const claim = expectDefined(repo.claim("agent", 1000));
  repo.commitResult(item.job.id, claim.fencingToken, response, {
    deliveryPayload: {
      groupName: "group",
      destinationType: "channel",
      destinationId: "channel",
      ...metadata,
    },
  });
  return item.job.id;
}
it("durably persists the created thread before its first message send", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const jobId = completed(repo, "response", {
    destinationType: "new-thread",
    destinationId: "channel",
    cronJobId: "daily",
  });
  const send = vi.fn(async () => {
    // The message send must only be invoked after the thread id is already
    // durable in the delivery row (pre-send crash-safety boundary).
    expect(repo.getDelivery(jobId)).toMatchObject({
      cronThreadId: "thread-1",
      status: "sending",
    });
    return { id: "message-1" };
  });
  const thread = { id: "thread-1", isSendable: () => true, send };
  const channel = { threads: { create: vi.fn(async () => thread) } };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockResolvedValue(channel as never);
  try {
    const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(repo.getDelivery(jobId)).toMatchObject({
      status: "sent",
      cronThreadId: "thread-1",
      externalMessageId: "message-1",
    });
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});
it("reuses the durably persisted cron thread for delivery", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const send = vi.fn(async () => ({ id: "message-1" }));
  const thread = { id: "thread-actual", isSendable: () => true, send };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockImplementation(async (id) => {
      expect(id).toBe("thread-actual");
      return thread as never;
    });
  try {
    const jobId = completed(repo, "response", {
      destinationType: "new-thread",
      destinationId: "channel",
      cronJobId: "daily",
      cronThreadId: "thread-actual",
    });
    const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(send).toHaveBeenCalledWith({
      content: "response",
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(repo.getDelivery(jobId)).toMatchObject({
      status: "sent",
      cronThreadId: "thread-actual",
    });
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});
it("marks transport failure during thread creation ambiguous without retrying", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const create = vi.fn(async () => {
    throw new TypeError("network timeout");
  });
  const channel = { threads: { create } };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockResolvedValue(channel as never);
  try {
    const jobId = completed(repo, "response", {
      destinationType: "new-thread",
      destinationId: "channel",
      cronJobId: "daily",
    });
    const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(repo.getDelivery(jobId)?.status).toBe("ambiguous");
    await worker.runOnce();
    expect(create).toHaveBeenCalledOnce();
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});
it("marks a 500 during thread creation ambiguous without retrying", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const create = vi.fn(async () => {
    throw Object.assign(new Error("Discord internal error after create"), {
      status: 500,
    });
  });
  const channel = { threads: { create } };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockResolvedValue(channel as never);
  try {
    const jobId = completed(repo, "response", {
      destinationType: "new-thread",
      destinationId: "channel",
      cronJobId: "daily",
    });
    const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(repo.getDelivery(jobId)?.status).toBe("ambiguous");
    await worker.runOnce();
    expect(create).toHaveBeenCalledOnce();
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});
it("reports a delivery failure inside the created thread without retrying the result", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const send = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("socket closed"))
    .mockResolvedValueOnce({ id: "error-message-1" });
  const thread = { id: "thread-1", isSendable: () => true, send };
  const channel = { threads: { create: vi.fn(async () => thread) } };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockImplementation(
      async (id) => (id === "channel" ? channel : thread) as never,
    );
  try {
    const jobId = completed(repo, "response", {
      destinationType: "new-thread",
      destinationId: "channel",
      cronJobId: "daily",
    });
    const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(repo.getDelivery(jobId)?.status).toBe("ambiguous");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith({
      content: expect.stringContaining("socket closed"),
      allowedMentions: { parse: [], repliedUser: false },
    });
    await worker.runOnce();
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});
it("marks a 502 during message send ambiguous without retrying", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const send = vi.fn(async () => {
    throw Object.assign(new Error("Discord bad gateway after send"), {
      statusCode: 502,
    });
  });
  const channel = { isSendable: () => true, send };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const cacheSpy = vi
    .spyOn(client.channels.cache, "get")
    .mockReturnValue(channel as never);
  try {
    const jobId = completed(repo, "response");
    const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(repo.getDelivery(jobId)?.status).toBe("ambiguous");
    await worker.runOnce();
    expect(send).toHaveBeenCalledOnce();
  } finally {
    readySpy.mockRestore();
    cacheSpy.mockRestore();
    repo.close();
  }
});
it("marks thread persistence failures ambiguous without creating a duplicate thread", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const thread = {
    id: "thread-1",
    isSendable: () => true,
    send: vi.fn(async () => ({ id: "message-1" })),
  };
  const create = vi.fn(async () => thread);
  const channel = { threads: { create } };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockResolvedValue(channel as never);
  const persistSpy = vi
    .spyOn(repo, "setDeliveryThread")
    .mockImplementation(() => {
      throw new Error("persistence outcome unknown");
    });
  try {
    const jobId = completed(repo, "response", {
      destinationType: "new-thread",
      destinationId: "channel",
      cronJobId: "daily",
    });
    const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(repo.getDelivery(jobId)?.status).toBe("ambiguous");
    expect(persistSpy).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(thread.send).not.toHaveBeenCalled();
    await worker.runOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(thread.send).not.toHaveBeenCalled();
  } finally {
    persistSpy.mockRestore();
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});

describe("durable delivery worker", () => {
  it("sends chunks without rerunning the agent and records external ids", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const send = vi.fn(async () => ({ externalMessageId: "discord-1" }));
    const adapter: DeliveryAdapter = { send };
    try {
      const jobId = completed(repo, "a".repeat(2001));
      const worker = new DeliveryWorker(repo, adapter, {
        workerId: "delivery-a",
      });
      await worker.runOnce();
      await worker.runOnce();
      expect(send).toHaveBeenCalledTimes(2);
      expect(repo.get(jobId)?.succeeded).toBe(true);
      expect(repo.listDeliveries("sent")).toHaveLength(2);
      expect(
        repo
          .listDeliveries("sent")
          .every((row) => row.externalMessageId === "discord-1"),
      ).toBe(true);
    } finally {
      repo.close();
    }
  });

  it("marks unknown API outcome ambiguous after the sending lease expires instead of retrying blindly", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const send = vi.fn(async () => {
      throw new DeliveryError("unknown", "connection lost after send");
    });
    try {
      const jobId = completed(repo, "response");
      const worker = new DeliveryWorker(
        repo,
        { send },
        { workerId: "delivery-a", leaseMs: 1 },
      );
      await worker.runOnce();
      expect(repo.getDelivery(jobId)?.status).toBe("ambiguous");
      expect(send).toHaveBeenCalledTimes(1);
      repo.resolveAmbiguousDelivery(
        expectDefined(repo.getDelivery(jobId)).id,
        "sent",
        "operator-confirmed",
      );
      expect(repo.getDelivery(jobId)?.status).toBe("sent");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      repo.close();
    }
  });

  it("retries retryable errors without touching the completed job", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    let count = 0;
    const adapter: DeliveryAdapter = {
      send: vi.fn(async () => {
        count += 1;
        if (count === 1) throw new DeliveryError("retryable", "429");
        return { externalMessageId: "ok" };
      }),
    };
    try {
      const jobId = completed(repo, "response");
      const worker = new DeliveryWorker(repo, adapter, {
        workerId: "delivery-a",
        retryDelayMs: 0,
      });
      await worker.runOnce();
      expect(repo.getDelivery(jobId)?.status).toBe("retry_wait");
      repo.db
        .prepare("UPDATE deliveries SET next_attempt_at=? WHERE job_id=?")
        .run(new Date(0).toISOString(), jobId);
      await worker.runOnce();
      expect(repo.getDelivery(jobId)?.status).toBe("sent");
      expect(repo.get(jobId)?.attempts).toBe(1);
    } finally {
      repo.close();
    }
  });
  it("propagates a newly created thread to every unsent split chunk", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const send = vi.fn(async () => ({
      id: `message-${send.mock.calls.length}`,
    }));
    const thread = { id: "thread-1", isSendable: () => true, send };
    const create = vi.fn(async () => thread);
    const channel = { threads: { create } };
    const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
    const fetchSpy = vi
      .spyOn(client.channels, "fetch")
      .mockImplementation(
        async (id) => (id === "channel" ? channel : thread) as never,
      );
    try {
      const jobId = completed(repo, "x".repeat(4001), {
        destinationType: "new-thread",
        destinationId: "channel",
        cronJobId: "daily",
      });
      const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
        workerId: "delivery-a",
      });
      while (await worker.runOnce()) {}
      const deliveries = repo.listDeliveries();
      expect(deliveries).toHaveLength(3);
      expect(deliveries.every((row) => row.cronThreadId === "thread-1")).toBe(
        true,
      );
      expect(create).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledTimes(3);
      expect(repo.get(jobId)?.succeeded).toBe(true);
    } finally {
      readySpy.mockRestore();
      fetchSpy.mockRestore();
      repo.close();
    }
  });

  it("only replies to the original message for the first split chunk", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const send = vi.fn(async (_payload: unknown) => ({ id: "message" }));
    const channel = { isSendable: () => true, send };
    const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
    const fetchSpy = vi
      .spyOn(client.channels, "fetch")
      .mockResolvedValue(channel as never);
    try {
      const jobId = completed(repo, "x".repeat(4001), {
        destinationType: "channel",
        destinationId: "channel",
        replyMessageId: "original-message",
      });
      const worker = new DeliveryWorker(repo, new DiscordDeliveryAdapter(), {
        workerId: "delivery-a",
      });
      while (await worker.runOnce()) {}
      const deliveries = repo.listDeliveries();
      expect(deliveries).toHaveLength(3);
      expect(deliveries[0]?.replyMessageId).toBe("original-message");
      expect(deliveries.slice(1).every((row) => !row.replyMessageId)).toBe(
        true,
      );
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[0]?.[0]).toMatchObject({
        reply: { messageReference: "original-message" },
        allowedMentions: { parse: [], repliedUser: false },
      });
      expect(
        send.mock.calls.slice(1).every(([content]) => {
          const payload = content as {
            allowedMentions?: { parse?: unknown[] };
          };
          return payload.allowedMentions?.parse?.length === 0;
        }),
      ).toBe(true);
      expect(repo.get(jobId)?.succeeded).toBe(true);
    } finally {
      readySpy.mockRestore();
      fetchSpy.mockRestore();
      repo.close();
    }
  });

  it("persists a newly created thread before retrying the same delivery", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const jobId = completed(repo, "response", {
      destinationType: "new-thread",
      destinationId: "channel",
      cronJobId: "daily",
    });
    let calls = 0;
    const adapter: DeliveryAdapter = {
      send: vi.fn(async (row, context) => {
        calls += 1;
        if (!row.cronThreadId) {
          context?.persistCronThread?.("thread-1");
          throw new DeliveryError("retryable", "message send failed");
        }
        return {
          externalMessageId: "message-1",
          cronThreadId: row.cronThreadId,
        };
      }),
    };
    try {
      const worker = new DeliveryWorker(repo, adapter, {
        workerId: "delivery-a",
        retryDelayMs: 0,
      });
      await worker.runOnce();
      const afterFailure = expectDefined(repo.getDelivery(jobId));
      expect(afterFailure.status).toBe("retry_wait");
      expect(afterFailure.cronThreadId).toBe("thread-1");
      repo.db
        .prepare("UPDATE deliveries SET next_attempt_at=? WHERE id=?")
        .run(new Date(0).toISOString(), afterFailure.id);
      await worker.runOnce();
      expect(repo.getDelivery(jobId)?.status).toBe("sent");
      expect(calls).toBe(2);
    } finally {
      repo.close();
    }
  });
});
