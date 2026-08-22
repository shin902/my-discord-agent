import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getProxyPort = vi.hoisted(() => vi.fn());
vi.mock("../../proxy/credential-proxy-server.js", () => ({ getProxyPort }));

const itemThreadQueue = vi.hoisted(() => ({
  findByIdempotencyKey: vi.fn(),
}));
vi.mock("../../queue/repository.js", () => ({
  getQueueRepository: () => itemThreadQueue,
}));

import type { CronContext } from "../runner.js";
import handler from "./mail.js";

function makeContext(
  appendInbox = vi.fn().mockResolvedValue(undefined),
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

function unreadResponse(): Response {
  return jsonResponse({
    value: [
      {
        id: "mail-1",
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
    getProxyPort.mockReturnValue(1234);
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
    expect(payload.idempotencyKey).toBeUndefined();
    expect(payload.mailEmailId).toBe("mail-1");
    expect(payload.cronPlaceholderMessageId).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("enqueues the unread email again on a later cron run without cross-run lookup", async () => {
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
    const first = appendInbox.mock.calls[0][0] as { sessionId: string };
    const second = appendInbox.mock.calls[1][0] as { sessionId: string };
    expect(second.sessionId).not.toBe(first.sessionId);
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
