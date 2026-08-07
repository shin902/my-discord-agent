import { describe, expect, it, vi } from "vitest";
import { expectDefined } from "../test-utils.js";
import { client } from "../discord/client.js";
import {
  DeliveryError,
  DeliveryWorker,
  DiscordDeliveryAdapter,
  type DeliveryAdapter,
} from "./delivery.js";
import {
  QueueRepository,
  openRuntimeDb,
  type DeliveryRow,
} from "./repository.js";

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
      destinationType: "channel",
      destinationId: "channel",
      ...metadata,
    },
  });
  return item.job.id;
}
it("persists a created thread before invoking its first message send", async () => {
  const send = vi.fn(async () => {
    expect(persisted).toEqual(["thread-1"]);
    return { id: "message-1" };
  });
  const thread = { id: "thread-1", isSendable: () => true, send };
  const channel = { threads: { create: vi.fn(async () => thread) } };
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockResolvedValue(channel as never);
  const persisted: string[] = [];
  const row: DeliveryRow = {
    id: "delivery-1",
    jobId: "job-1",
    status: "sending",
    payloadJson: JSON.stringify({
      destinationType: "new-thread",
      destinationId: "channel",
      content: "hello",
      cronJobId: "daily",
    }),
    createdAt: new Date().toISOString(),
  };
  try {
    await new DiscordDeliveryAdapter().send(row, {
      persistCronThread: (id) => {
        persisted.push(id);
      },
    });
    expect(persisted).toEqual(["thread-1"]);
    expect(send).toHaveBeenCalledOnce();
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
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
