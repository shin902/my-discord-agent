import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProxyPort: vi.fn(),
  queueRepo: {
    findByIdempotencyKey: vi.fn(),
    patchJobPayload: vi.fn(),
    provisionCronJob: vi.fn(),
    listDeliveries: vi.fn(),
  },
}));

vi.mock("../../proxy/credential-proxy-server.js", () => ({
  getProxyPort: mocks.getProxyPort,
}));
vi.mock("../../queue/repository.js", () => ({
  getQueueRepository: () => mocks.queueRepo,
}));

import type { CronContext } from "../runner.js";

function makeContext(
  channel: unknown,
  appendInbox = vi.fn(),
  threadLookup?: unknown,
): CronContext {
  const fetch = vi.fn().mockResolvedValueOnce(channel);
  if (threadLookup instanceof Error) {
    fetch.mockRejectedValueOnce(threadLookup);
  } else if (threadLookup !== undefined) {
    fetch.mockResolvedValueOnce(threadLookup);
  }
  return {
    id: "mail",
    schedule: "15m",
    enabled: true,
    handler: "jobs/mail.ts",
    groupName: "mail",
    channelId: "channel",
    appendInbox,
    client: { channels: { fetch } } as never,
  };
}

function unread(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        value: [
          {
            id: "mail-1",
            subject: "件名",
            from: { emailAddress: { address: "from@example.com" } },
          },
        ],
      }),
    ),
  );
}

function body(fetchMock: ReturnType<typeof vi.fn>): void {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({ body: { contentType: "text", content: "本文" } }),
    ),
  );
}

describe("mail cron queue boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getProxyPort.mockReturnValue(1234);
    mocks.queueRepo.findByIdempotencyKey.mockReturnValue(undefined);
  });

  it("registers stable queue metadata before provisioning Discord", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    unread(fetchMock);
    body(fetchMock);
    const appendInbox = vi.fn().mockResolvedValue(undefined);
    mocks.queueRepo.findByIdempotencyKey
      .mockReturnValueOnce(undefined)
      .mockReturnValue({
        id: "job-1",
        status: "queued",
        cronProvisioning: true,
      });
    mocks.queueRepo.provisionCronJob.mockReturnValue({ id: "job-1" });
    const startThread = vi.fn().mockResolvedValue({ id: "thread-1" });
    const send = vi
      .fn()
      .mockResolvedValue({ id: "placeholder-1", startThread });
    await (await import("./mail.js")).default(
      makeContext({ type: 0, send }, appendInbox),
    );
    expect(appendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "mail:mail-1",
        cronProvisioning: true,
        cronSourceId: "mail-1",
      }),
    );
    expect(send).toHaveBeenCalledWith("処理中…");
    expect(startThread).toHaveBeenCalledOnce();
    expect(mocks.queueRepo.provisionCronJob).toHaveBeenCalledWith(
      "job-1",
      "thread-1",
      expect.objectContaining({ cronPlaceholderMessageId: "placeholder-1" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers a persisted placeholder thread after a cache-miss restart", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    unread(fetchMock);
    const startThread = vi.fn();
    const message = {
      id: "placeholder-1",
      startThread,
    };
    const existingThread = { id: "placeholder-1", parentId: "channel" };
    mocks.queueRepo.findByIdempotencyKey.mockReturnValue({
      id: "job-1",
      status: "queued",
      cronProvisioning: true,
      cronPlaceholderMessageId: "placeholder-1",
    });
    mocks.queueRepo.provisionCronJob.mockReturnValue({ id: "job-1" });
    const messages = { fetch: vi.fn().mockResolvedValue(message) };
    const send = vi.fn();
    const channel = { type: 0, send, messages };
    const context = makeContext(channel, vi.fn(), existingThread);
    await (await import("./mail.js")).default(context);
    expect(send).not.toHaveBeenCalled();
    expect(messages.fetch).toHaveBeenCalledWith("placeholder-1");
    expect(
      (
        context.client as unknown as {
          channels: { fetch: ReturnType<typeof vi.fn> };
        }
      ).channels.fetch,
    ).toHaveBeenNthCalledWith(2, "placeholder-1", { force: true });
    expect(startThread).not.toHaveBeenCalled();
    expect(mocks.queueRepo.provisionCronJob).toHaveBeenCalledWith(
      "job-1",
      "placeholder-1",
      expect.objectContaining({ cronPlaceholderMessageId: "placeholder-1" }),
    );
  });

  it.each([
    Object.assign(new Error("unknown channel"), { status: 404 }),
    Object.assign(new Error("unknown channel"), { code: 10003 }),
  ])("creates a thread after a definitive missing-thread lookup", async (lookupError) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    unread(fetchMock);
    const startThread = vi.fn().mockResolvedValue({ id: "thread-new" });
    const message = { id: "placeholder-1", startThread };
    const messages = { fetch: vi.fn().mockResolvedValue(message) };
    const send = vi.fn();
    const channel = { type: 0, send, messages };
    mocks.queueRepo.findByIdempotencyKey.mockReturnValue({
      id: "job-1",
      status: "queued",
      cronProvisioning: true,
      cronPlaceholderMessageId: "placeholder-1",
    });
    await (await import("./mail.js")).default(
      makeContext(channel, vi.fn(), lookupError),
    );
    expect(startThread).toHaveBeenCalledOnce();
    expect(mocks.queueRepo.provisionCronJob).toHaveBeenCalledWith(
      "job-1",
      "thread-new",
      expect.any(Object),
    );
  });

  it.each([
    Object.assign(new Error("forbidden"), { status: 403 }),
    new Error("network timeout"),
  ])("does not create a thread after an uncertain lookup failure", async (lookupError) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    unread(fetchMock);
    const startThread = vi.fn();
    const message = { id: "placeholder-1", startThread };
    const messages = { fetch: vi.fn().mockResolvedValue(message) };
    const send = vi.fn();
    const channel = { type: 0, send, messages };
    mocks.queueRepo.findByIdempotencyKey.mockReturnValue({
      id: "job-1",
      status: "queued",
      cronProvisioning: true,
      cronPlaceholderMessageId: "placeholder-1",
    });
    await (await import("./mail.js")).default(
      makeContext(channel, vi.fn(), lookupError),
    );
    expect(startThread).not.toHaveBeenCalled();
    expect(mocks.queueRepo.provisionCronJob).not.toHaveBeenCalled();
  });

  it("ACKs only completed jobs whose every delivery is sent", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    unread(fetchMock);
    mocks.queueRepo.findByIdempotencyKey.mockReturnValue({
      id: "job-1",
      status: "completed",
    });
    mocks.queueRepo.listDeliveries.mockReturnValue([
      { jobId: "job-1", status: "sent" },
      { jobId: "job-1", status: "sent" },
    ]);
    await (await import("./mail.js")).default(
      makeContext({ type: 0, send: vi.fn() }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/me/messages/mail-1"),
      expect.objectContaining({ method: "PATCH" }),
    );
    fetchMock.mockReset();
    unread(fetchMock);
    mocks.queueRepo.listDeliveries.mockReturnValue([
      { jobId: "job-1", status: "sent" },
      { jobId: "job-1", status: "pending" },
    ]);
    await (await import("./mail.js")).default(
      makeContext({ type: 0, send: vi.fn() }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a failed mail ACK on the next cron invocation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    unread(fetchMock);
    mocks.queueRepo.findByIdempotencyKey.mockReturnValue({
      id: "job-1",
      status: "completed",
    });
    mocks.queueRepo.listDeliveries.mockReturnValue([
      { jobId: "job-1", status: "sent" },
    ]);
    fetchMock.mockResolvedValueOnce(new Response("failure", { status: 503 }));
    await (await import("./mail.js")).default(
      makeContext({ type: 0, send: vi.fn() }),
    );
    fetchMock.mockReset();
    unread(fetchMock);
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    await (await import("./mail.js")).default(
      makeContext({ type: 0, send: vi.fn() }),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/me/messages/mail-1"),
      expect.objectContaining({ method: "PATCH" }),
    );
  });
});
