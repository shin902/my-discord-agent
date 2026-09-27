import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelType, MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

const acknowledgeEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../cron/mail-ack.js", () => ({ acknowledgeEmail }));

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

import { registerMailSource } from "../features/mail.js";
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
  DiscordDeliveryAdapter,
} from "./delivery.js";
import { openRuntimeDb, QueueRepository } from "./repository.js";
import { SourceHandlers } from "./source-handlers.js";

function makeWorker(
  repo: QueueRepository,
  adapter: DeliveryAdapter = new DiscordDeliveryAdapter(),
  options: ConstructorParameters<typeof DeliveryWorker>[2] = {},
): DeliveryWorker {
  const sources = new SourceHandlers();
  registerMailSource(sources);
  registerRssSource(sources, repo);
  repo.registerSources(sources);
  return new DeliveryWorker(repo, adapter, options, sources);
}

function completed(
  repo: QueueRepository,
  response: string,
  metadata: Record<string, unknown> = {},
) {
  const mailId = metadata.mailEmailId;
  const rssId = metadata.rssDispatchId;
  const feature =
    typeof mailId === "string"
      ? {
          kind: "mail",
          input: { emailId: mailId, routeKey: metadata.mailRouteKey },
        }
      : typeof rssId === "string"
        ? {
            kind: "rss",
            input: {
              dispatchId: rssId,
              statePath: metadata.rssStatePath,
              dispatchJobId: metadata.rssDispatchJobId,
            },
          }
        : undefined;
  const rest = { ...metadata };
  for (const key of [
    "mailEmailId",
    "mailRouteKey",
    "rssDispatchId",
    "rssStatePath",
    "rssDispatchJobId",
  ])
    delete rest[key];
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
      ...rest,
      ...(feature ? { feature } : {}),
    },
  });
  return item.job.id;
}

it("rejects pre-materialized placeholder delivery without Discord mutation", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const jobId = completed(repo, "response", {
    destinationType: "item-thread",
    destinationId: "channel",
    cronThreadId: "thread-1",
    cronPlaceholderMessageId: "placeholder-1",
  });
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi.spyOn(client.channels, "fetch");
  try {
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-pre-materialized-reject",
      retryDelayMs: 0,
    });
    await worker.runOnce();
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId),
    ).toMatchObject({ status: "failed", attempts: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    await worker.runOnce(new Date(Date.now() + 1));
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId),
    ).toMatchObject({ status: "failed", attempts: 1 });
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});

it("durably persists the created thread before its first message send", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const jobId = completed(repo, "response", {
    destinationType: "new-thread",
    destinationId: "channel",
    cronJobId: "daily",
  });
  const send = vi.fn(async () => {
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId),
    ).toMatchObject({
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
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId),
    ).toMatchObject({
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
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(send).toHaveBeenCalledWith({
      content: "response",
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId),
    ).toMatchObject({
      status: "sent",
      cronThreadId: "thread-actual",
    });
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});

it("creates a Mail thread when no mapping exists", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const send = vi.fn(async () => ({ id: "message-1" }));
  const thread = { id: "thread-1", isSendable: () => true, send };
  const create = vi.fn(async () => thread);
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi.spyOn(client.channels, "fetch").mockResolvedValue({
    type: ChannelType.GuildText,
    threads: { create },
  } as never);
  try {
    completed(repo, "first", {
      destinationType: "channel",
      destinationId: "channel",
      mailEmailId: "mail-1",
      mailRouteKey: "mail:a@example.com",
    });
    await makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "mail-create",
    }).runOnce();
    expect(create).toHaveBeenCalledWith({ name: "a@example.com" });
    expect(repo.getMailThread("group", "channel", "mail:a@example.com")).toBe(
      "thread-1",
    );
    expect(send).toHaveBeenCalledOnce();
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});

it("rejects a Mail route whose destination is already a thread", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const create = vi.fn();
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi.spyOn(client.channels, "fetch").mockResolvedValue({
    type: ChannelType.PublicThread,
    threads: { create },
  } as never);
  try {
    const jobId = completed(repo, "response", {
      destinationType: "channel",
      destinationId: "existing-thread",
      mailEmailId: "mail-1",
      mailRouteKey: "mail:a@example.com",
    });
    await makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "mail-thread-parent",
    }).runOnce();
    expect(create).not.toHaveBeenCalled();
    expect(
      repo.listDeliveries().find((row) => row.jobId === jobId),
    ).toMatchObject({ status: "failed", attempts: 1 });
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});

it("reuses a Mail thread and replaces a deleted mapping", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const firstSend = vi.fn(async () => ({ id: "message-1" }));
  const replacementSend = vi.fn(async () => ({ id: "message-2" }));
  const replacement = {
    id: "thread-2",
    isSendable: () => true,
    send: replacementSend,
  };
  const channel = {
    type: ChannelType.GuildText,
    threads: { create: vi.fn(async () => replacement) },
  };
  repo.setMailThread("group", "channel", "mail:a@example.com", "thread-1");
  const readySpy = vi.spyOn(client, "isReady").mockReturnValue(true);
  const fetchSpy = vi
    .spyOn(client.channels, "fetch")
    .mockImplementation(async (id) => {
      if (id === "thread-1")
        return {
          id,
          isSendable: () => true,
          send: firstSend,
        } as never;
      if (id === "missing-thread")
        throw Object.assign(new Error("Unknown Channel"), { status: 404 });
      return channel as never;
    });
  try {
    completed(repo, "first", {
      destinationType: "channel",
      destinationId: "channel",
      mailEmailId: "mail-1",
      mailRouteKey: "mail:a@example.com",
    });
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-keyed",
    });
    await worker.runOnce();
    expect(firstSend).toHaveBeenCalledOnce();
    expect(channel.threads.create).not.toHaveBeenCalled();

    repo.setMailThread(
      "group",
      "channel",
      "mail:a@example.com",
      "missing-thread",
    );
    completed(repo, "second", {
      destinationType: "channel",
      destinationId: "channel",
      mailEmailId: "mail-2",
      mailRouteKey: "mail:a@example.com",
    });
    await worker.runOnce();
    expect(replacementSend).toHaveBeenCalledOnce();
    expect(channel.threads.create).toHaveBeenCalledWith({
      name: "a@example.com",
    });
    expect(repo.getMailThread("group", "channel", "mail:a@example.com")).toBe(
      "thread-2",
    );
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
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
        ?.status,
    ).toBe("ambiguous");
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
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
        ?.status,
    ).toBe("ambiguous");
    await worker.runOnce();
    expect(create).toHaveBeenCalledOnce();
  } finally {
    readySpy.mockRestore();
    fetchSpy.mockRestore();
    repo.close();
  }
});

it("marks transport failure during message send ambiguous without retrying", async () => {
  const repo = new QueueRepository(openRuntimeDb(":memory:"));
  const send = vi.fn(async () => {
    throw new TypeError("socket closed");
  });
  const thread = { id: "thread-1", isSendable: () => true, send };
  const channel = { threads: { create: vi.fn(async () => thread) } };
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
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
        ?.status,
    ).toBe("ambiguous");
    await worker.runOnce();
    expect(send).toHaveBeenCalledOnce();
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
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
        ?.status,
    ).toBe("ambiguous");
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
    const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
      workerId: "delivery-a",
    });
    await worker.runOnce();
    expect(
      repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
        ?.status,
    ).toBe("ambiguous");
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
      const worker = makeWorker(repo, adapter, {
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

  it("ACKs direct mail only after every Discord delivery chunk is sent", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const adapter: DeliveryAdapter = {
      send: vi.fn(async () => ({ externalMessageId: "discord-1" })),
    };
    acknowledgeEmail.mockClear();
    try {
      completed(repo, "a".repeat(2001), {
        destinationType: "channel",
        destinationId: "channel",
        cronJobId: "mail-check",
        mailEmailId: "mail-1",
      });
      const worker = makeWorker(repo, adapter, {
        workerId: "delivery-a",
      });

      await worker.runOnce();
      expect(acknowledgeEmail).not.toHaveBeenCalled();

      await worker.runOnce();
      expect(acknowledgeEmail).toHaveBeenCalledOnce();
      expect(acknowledgeEmail).toHaveBeenCalledWith("mail-1");
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
      const worker = makeWorker(
        repo,
        { send },
        { workerId: "delivery-a", leaseMs: 1 },
      );
      await worker.runOnce();
      expect(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
          ?.status,
      ).toBe("ambiguous");
      expect(send).toHaveBeenCalledTimes(1);
      repo.resolveAmbiguousDelivery(
        expectDefined(
          repo.listDeliveries().find((delivery) => delivery.jobId === jobId),
        ).id,
        "sent",
        "operator-confirmed",
      );
      expect(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
          ?.status,
      ).toBe("sent");
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      repo.close();
    }
  });

  it("RSSの複数チャンクは全送信成功まで既読化せず、途中失敗でclaimを解放する", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const rssDir = await mkdtemp(join(tmpdir(), "delivery-rss-chunks-test-"));
    const rssPath = join(rssDir, "rss.sqlite3");
    const rssDb = openRssDb(rssPath);
    saveFeedEntries(rssDb, {
      url: "https://example.com/feed.xml",
      parsedName: "Feed",
      etag: null,
      lastModified: null,
      entries: [
        {
          entryId: "entry-1",
          title: "Article",
          link: "https://example.com/article",
          publishedAt: "2026-08-19",
          summary: "Summary",
        },
      ],
      markInitialAsRead: false,
    });
    const dispatch = expectDefined(claimUnreadArticles(rssDb, "rss-owner", 1));
    rssDb.close();
    let sends = 0;
    const adapter: DeliveryAdapter = {
      send: vi.fn(async () => {
        sends += 1;
        if (sends === 2) throw new DeliveryError("retryable", "429");
        return { externalMessageId: `message-${sends}` };
      }),
    };
    try {
      const jobId = completed(repo, "x".repeat(4001), {
        rssDispatchId: dispatch.id,
        rssStatePath: rssPath,
        rssDispatchJobId: dispatch.jobId,
      });
      const worker = makeWorker(repo, adapter, {
        workerId: "delivery-a",
      });
      await worker.runOnce();
      const afterFirst = openRssDb(rssPath);
      try {
        expect(listDispatchClaims(afterFirst)).toHaveLength(1);
        expect(listUnreadArticles(afterFirst, 10)).toHaveLength(1);
      } finally {
        afterFirst.close();
      }
      await worker.runOnce();
      expect(
        repo
          .listDeliveries()
          .filter((delivery) => delivery.jobId === jobId)
          .map((delivery) => delivery.status),
      ).toEqual(["sent", "failed", "failed"]);
      await worker.runOnce();
      expect(adapter.send).toHaveBeenCalledTimes(2);
      const checkDb = openRssDb(rssPath);
      try {
        expect(listDispatchClaims(checkDb)).toEqual([]);
        expect(listUnreadArticles(checkDb, 10)).toHaveLength(1);
      } finally {
        checkDb.close();
      }
    } finally {
      repo.close();
      await rm(rssDir, { recursive: true, force: true });
    }
  });

  it("RSSのretryableなDiscord失敗はclaimを解放し、deliveryを再試行しない", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const rssDir = await mkdtemp(join(tmpdir(), "delivery-rss-test-"));
    const rssPath = join(rssDir, "rss.sqlite3");
    const rssDb = openRssDb(rssPath);
    saveFeedEntries(rssDb, {
      url: "https://example.com/feed.xml",
      parsedName: "Feed",
      etag: null,
      lastModified: null,
      entries: [
        {
          entryId: "entry-1",
          title: "Article",
          link: "https://example.com/article",
          publishedAt: "2026-08-19",
          summary: "Summary",
        },
      ],
      markInitialAsRead: false,
    });
    const dispatch = expectDefined(claimUnreadArticles(rssDb, "rss-owner", 1));
    rssDb.close();
    const adapter: DeliveryAdapter = {
      send: vi.fn(async () => {
        throw new DeliveryError("retryable", "429");
      }),
    };
    try {
      const jobId = completed(repo, "response", {
        rssDispatchId: dispatch.id,
        rssStatePath: rssPath,
        rssDispatchJobId: dispatch.jobId,
      });
      const worker = makeWorker(repo, adapter, {
        workerId: "delivery-a",
      });
      await worker.runOnce();
      expect(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
          ?.status,
      ).toBe("failed");
      const checkDb = openRssDb(rssPath);
      try {
        expect(listDispatchClaims(checkDb)).toEqual([]);
        expect(listUnreadArticles(checkDb, 10)).toHaveLength(1);
      } finally {
        checkDb.close();
      }
    } finally {
      repo.close();
      await rm(rssDir, { recursive: true, force: true });
    }
  });

  it("RSS stale fencing failure does not release the claim", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const rssDir = await mkdtemp(join(tmpdir(), "delivery-rss-stale-test-"));
    const rssPath = join(rssDir, "rss.sqlite3");
    const rssDb = openRssDb(rssPath);
    saveFeedEntries(rssDb, {
      url: "https://example.com/feed.xml",
      parsedName: "Feed",
      etag: null,
      lastModified: null,
      entries: [
        {
          entryId: "entry-1",
          title: "Article",
          link: "https://example.com/article",
          publishedAt: "2026-08-19",
          summary: "Summary",
        },
      ],
      markInitialAsRead: false,
    });
    const dispatch = expectDefined(claimUnreadArticles(rssDb, "rss-owner", 1));
    rssDb.close();
    try {
      const jobId = completed(repo, "response", {
        rssDispatchId: dispatch.id,
        rssStatePath: rssPath,
        rssDispatchJobId: dispatch.jobId,
      });
      vi.spyOn(repo, "failDeliveryBatch").mockImplementation(() => {
        throw new Error("stale fencing token");
      });
      const worker = makeWorker(
        repo,
        {
          send: vi.fn(async () => {
            throw new DeliveryError("retryable", "429");
          }),
        },
        { workerId: "delivery-a" },
      );
      await worker.runOnce();
      expect(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
          ?.status,
      ).toBe("sending");
      const checkDb = openRssDb(rssPath);
      try {
        expect(listDispatchClaims(checkDb)).toHaveLength(1);
      } finally {
        checkDb.close();
      }
    } finally {
      repo.close();
      await rm(rssDir, { recursive: true, force: true });
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
      const worker = makeWorker(repo, adapter, {
        workerId: "delivery-a",
        retryDelayMs: 0,
      });
      await worker.runOnce();
      expect(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
          ?.status,
      ).toBe("retry_wait");
      repo.db
        .prepare("UPDATE deliveries SET next_attempt_at=? WHERE job_id=?")
        .run(new Date(0).toISOString(), jobId);
      await worker.runOnce();
      expect(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
          ?.status,
      ).toBe("sent");
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
      const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
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
      const worker = makeWorker(repo, new DiscordDeliveryAdapter(), {
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
        flags: MessageFlags.SuppressEmbeds,
      });
      expect(
        send.mock.calls.slice(1, -1).every(([content]) => {
          const payload = content as {
            allowedMentions?: { parse?: unknown[] };
            flags?: number;
          };
          return (
            payload.allowedMentions?.parse?.length === 0 &&
            payload.flags === MessageFlags.SuppressEmbeds
          );
        }),
      ).toBe(true);
      expect(send.mock.calls[send.mock.calls.length - 1]?.[0]).toEqual({
        content: expect.any(String),
        allowedMentions: { parse: [], repliedUser: false },
      });
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
      const worker = makeWorker(repo, adapter, {
        workerId: "delivery-a",
        retryDelayMs: 0,
      });
      await worker.runOnce();
      const afterFailure = expectDefined(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId),
      );
      expect(afterFailure.status).toBe("retry_wait");
      expect(afterFailure.cronThreadId).toBe("thread-1");
      repo.db
        .prepare("UPDATE deliveries SET next_attempt_at=? WHERE id=?")
        .run(new Date(0).toISOString(), afterFailure.id);
      await worker.runOnce();
      expect(
        repo.listDeliveries().find((delivery) => delivery.jobId === jobId)
          ?.status,
      ).toBe("sent");
      expect(calls).toBe(2);
    } finally {
      repo.close();
    }
  });
});
