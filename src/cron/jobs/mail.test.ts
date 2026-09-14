import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise real hostFetch; no Credential Proxy listener or port is available.
vi.mock("../../config/credential-proxy.js", () => ({
  loadCredentialProxy: async () => [
    {
      provider: "graph",
      baseUrl: "https://graph.fixture.test/v1.0",
      msal: {
        tenantId: "tenant",
        clientId: "client",
        scopes: ["Mail.ReadWrite"],
      },
    },
  ],
}));
vi.mock("../../config/proxy-config.js", () => ({
  loadRequestTimeoutMs: async () => 30000,
}));
vi.mock("../../proxy/graph-auth.js", () => ({
  getGraphAccessToken: async () => "host-graph-token",
}));

import { DeliveryError, DeliveryWorker } from "../../queue/delivery.js";
import { QueueRepository } from "../../queue/repository.js";
import type { QueueProducer } from "../../queue/types.js";
import { expectDefined } from "../../test-utils.js";
import type { CronContext } from "../runner.js";
import handler from "./mail.js";

function makeContext(
  appendInbox: QueueProducer = vi.fn().mockResolvedValue(undefined),
  modes: {
    deliveryMode: NonNullable<CronContext["deliveryMode"]>;
    sessionMode: NonNullable<CronContext["sessionMode"]>;
  } = {
    deliveryMode: "new-thread",
    sessionMode: "destination",
  },
): CronContext {
  return {
    id: "mail",
    schedule: "15m",
    enabled: true,
    handler: "jobs/mail.ts",
    groupName: "mail",
    channelId: "channel",
    appendInbox,
    client: {} as never,
    ...modes,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function unreadResponse(emailId = "mail-1"): Response {
  return jsonResponse({
    value: [
      {
        id: emailId,
        subject: "件名",
        from: { emailAddress: { address: "from@example.com" } },
      },
    ],
  });
}

function bodyResponse(): Response {
  return jsonResponse({ body: { contentType: "text", content: "本文" } });
}

describe("mail cron queue boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("enqueues a fresh new-thread job without ACKing before delivery", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unreadResponse())
      .mockResolvedValueOnce(bodyResponse());
    vi.stubGlobal("fetch", fetchMock);
    const appendInbox = vi.fn().mockResolvedValue(undefined);

    await handler(makeContext(appendInbox));

    expect(appendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        cronDeliveryMode: "new-thread",
        cronSessionMode: "destination",
        cronJobId: "mail",
        content: expect.stringContaining("件名: 件名"),
      }),
    );
    const payload = appendInbox.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.sessionId).toEqual(expect.stringMatching(/^cron-mail-/));
    expect(payload.idempotencyKey).toBe("mail:graph:mail:mail-1");
    expect(payload.mailEmailId).toBe("mail-1");
    expect(payload.cronPlaceholderMessageId).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://graph.fixture.test/v1.0/me/mailFolders/inbox/messages?$top=20&$select=id,subject,from&$orderby=receivedDateTime asc&$filter=isRead eq false",
      expect.objectContaining({
        headers: { Authorization: "Bearer host-graph-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://graph.fixture.test/v1.0/me/messages/mail-1?$select=body",
      expect.objectContaining({
        headers: { Authorization: "Bearer host-graph-token" },
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("host-graph-token");
  });

  it("reuses the durable idempotency key when the email stays unread", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unreadResponse())
      .mockResolvedValueOnce(bodyResponse())
      .mockResolvedValueOnce(unreadResponse())
      .mockResolvedValueOnce(bodyResponse());
    vi.stubGlobal("fetch", fetchMock);
    const appendInbox = vi.fn().mockResolvedValue(undefined);
    const context = makeContext(appendInbox);

    await handler(context);
    await handler(context);

    expect(appendInbox).toHaveBeenCalledTimes(2);
    const payloads = appendInbox.mock.calls.map(
      ([payload]) => payload as { idempotencyKey?: string },
    );
    expect(payloads.map(({ idempotencyKey }) => idempotencyKey)).toEqual([
      "mail:graph:mail:mail-1",
      "mail:graph:mail:mail-1",
    ]);
  });

  it("scopes the same Graph message to each cron job", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(unreadResponse())
        .mockResolvedValueOnce(bodyResponse())
        .mockResolvedValueOnce(unreadResponse())
        .mockResolvedValueOnce(bodyResponse()),
    );
    const appendInbox = vi.fn().mockResolvedValue(undefined);

    await handler(makeContext(appendInbox));
    await handler({ ...makeContext(appendInbox), id: "mail-secondary" });

    expect(
      appendInbox.mock.calls.map(([payload]) => payload.idempotencyKey),
    ).toEqual(["mail:graph:mail:mail-1", "mail:graph:mail-secondary:mail-1"]);
  });

  it("escapes identity components so delimiters cannot conflate different cron jobs", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(unreadResponse("part:mail-1"))
        .mockResolvedValueOnce(bodyResponse())
        .mockResolvedValueOnce(unreadResponse())
        .mockResolvedValueOnce(bodyResponse()),
    );
    const appendInbox = vi.fn();

    await handler(makeContext(appendInbox));
    await handler({ ...makeContext(appendInbox), id: "mail:part" });

    expect(
      appendInbox.mock.calls.map(([payload]) => payload.idempotencyKey),
    ).toEqual([
      "mail:graph:mail:part%3Amail-1",
      "mail:graph:mail%3Apart:mail-1",
    ]);
  });

  it("does not ACK when enqueue fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unreadResponse())
      .mockResolvedValueOnce(bodyResponse());
    vi.stubGlobal("fetch", fetchMock);
    const appendInbox = vi.fn().mockRejectedValue(new Error("queue down"));

    await handler(makeContext(appendInbox));

    expect(appendInbox).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates unread-fetch failures without enqueueing or ACKing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "unavailable" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    const appendInbox = vi.fn();
    await expect(handler(makeContext(appendInbox))).rejects.toThrow(
      "Graph API エラー 503",
    );
    expect(appendInbox).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("passes through the configured item-thread mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unreadResponse())
      .mockResolvedValueOnce(bodyResponse());
    vi.stubGlobal("fetch", fetchMock);
    const appendInbox = vi.fn().mockResolvedValue(undefined);

    await handler(
      makeContext(appendInbox, {
        deliveryMode: "item-thread",
        sessionMode: "destination",
      }),
    );

    expect(appendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        cronDeliveryMode: "item-thread",
        cronSessionMode: "destination",
        cronProvisioning: true,
        mailEmailId: "mail-1",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// Real handler -> cron enqueue -> durable repository, with Graph left unread.
describe("mail active-only dedupe", () => {
  let repo: QueueRepository;
  let fetchMock: ReturnType<typeof vi.fn>;

  function context(id = "mail", maxAttempts = 10): CronContext {
    return {
      ...makeContext((payload) => {
        repo.enqueue(payload, { maxAttempts });
      }),
      id,
    };
  }

  function currentJob() {
    return expectDefined(repo.findByIdempotencyKey("mail:graph:mail:mail-1"));
  }

  function jobs() {
    return repo.db.prepare("SELECT id,status FROM jobs").all();
  }

  beforeEach(() => {
    repo = new QueueRepository(":memory:");
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ error: "Graph unavailable" }, 503);
      }
      return url.includes("/mailFolders/") ? unreadResponse() : bodyResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    repo.close();
    vi.unstubAllGlobals();
  });

  it.each([
    "queued",
    "claimed",
    "running",
    "retry_wait",
  ])("dedupes while the queue job is %s", async (status) => {
    await handler(context());
    const first = currentJob();
    if (status !== "queued") {
      const claim = expectDefined(repo.claim());
      if (status === "running") repo.markRunning(first.id, claim.fencingToken);
      if (status === "retry_wait")
        repo.failAttempt(first.id, "transient", claim.fencingToken);
    }
    expect(jobs()).toEqual([{ id: first.id, status }]);

    await handler(context());

    expect(jobs()).toEqual([{ id: first.id, status }]);
    expect(
      fetchMock.mock.calls.every(([, init]) => init.method !== "PATCH"),
    ).toBe(true);
  });

  it.each([
    "completed",
    "dead_letter",
    "max_attempts",
    "expired_lease",
  ])("re-enqueues unread mail after %s, then dedupes the new active job", async (outcome) => {
    await handler(context("mail", 1));
    const first = currentJob();
    // Use the normal repository transitions, including retry exhaustion.
    const claim = expectDefined(repo.claim());
    if (outcome === "completed") {
      repo.commitResult(first.id, claim.fencingToken, "response");
      expect(repo.listDeliveries("pending")).toHaveLength(1);
    } else if (outcome === "dead_letter") {
      repo.deadLetter(first.id, claim.fencingToken, "non_retryable");
    } else {
      if (outcome === "max_attempts")
        repo.failAttempt(first.id, "failed", claim.fencingToken);
      else repo.claim("after-lease", 1000, new Date(Date.now() + 120_000));
    }
    expect(repo.get(first.id)?.status).toBe(
      outcome === "completed" ? "completed" : "dead_letter",
    );

    await handler(context());
    const second = currentJob();
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("queued");
    expect(repo.get(first.id)?.idempotencyKey).toBeUndefined();
    await handler(context());
    expect(currentJob().id).toBe(second.id);
    expect(jobs()).toHaveLength(2);
  });

  it("enqueues the same Graph message independently for concurrent cron jobs", async () => {
    await Promise.all([handler(context()), handler(context("mail-secondary"))]);

    expect(jobs()).toHaveLength(2);
    expect(repo.findByIdempotencyKey("mail:graph:mail:mail-1")?.cronJobId).toBe(
      "mail",
    );
    expect(
      repo.findByIdempotencyKey("mail:graph:mail-secondary:mail-1")?.cronJobId,
    ).toBe("mail-secondary");
  });

  it.each([
    "direct",
    "new-thread",
    "item-thread",
  ] as const)("dedupes concurrent handlers in %s mode", async (deliveryMode) => {
    const ctx = { ...context(), deliveryMode };
    await Promise.all([handler(ctx), handler(ctx)]);
    expect(jobs()).toHaveLength(1);
    expect(currentJob().cronDeliveryMode).toBe(deliveryMode);
  });

  it("re-enqueues after delivery succeeds but Graph ACK fails", async () => {
    await handler(context());
    const first = currentJob();
    const claim = expectDefined(repo.claim());
    repo.commitResult(first.id, claim.fencingToken, "response", {
      deliveryPayload: { mailEmailId: first.mailEmailId },
    });
    const send = vi.fn(async () => ({ externalMessageId: "discord-1" }));
    const worker = new DeliveryWorker(repo, { send });

    await worker.runOnce();

    expect(repo.listDeliveries("sent")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.fixture.test/v1.0/me/messages/mail-1",
      expect.objectContaining({ method: "PATCH" }),
    );
    // No ACK-only retry: recovery uses the next normal cron invocation.
    expect(await worker.runOnce()).toBe(false);
    await handler(context());
    expect(currentJob().id).not.toBe(first.id);
    expect(jobs()).toHaveLength(2);
    expect(send).toHaveBeenCalledOnce();
  });

  it.each([
    ["non-retryable", "failed"],
    ["unknown", "ambiguous"],
  ] as const)("re-enqueues after %s delivery failure without ACK", async (kind, status) => {
    await handler(context());
    const first = currentJob();
    const claim = expectDefined(repo.claim());
    repo.commitResult(first.id, claim.fencingToken, "response", {
      deliveryPayload: { mailEmailId: first.mailEmailId },
    });
    const worker = new DeliveryWorker(repo, {
      send: async () => {
        throw new DeliveryError(kind, "delivery failed");
      },
    });

    await worker.runOnce();

    expect(repo.listDeliveries(status)).toHaveLength(1);
    expect(
      fetchMock.mock.calls.every(([, init]) => init.method !== "PATCH"),
    ).toBe(true);
    await handler(context());
    expect(currentJob().id).not.toBe(first.id);
    expect(jobs()).toHaveLength(2);
  });
});
