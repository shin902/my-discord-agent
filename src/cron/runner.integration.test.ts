import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const discordClient = vi.hoisted(() => ({
  isReady: vi.fn(() => false),
  channels: { fetch: vi.fn() },
}));
vi.mock("../discord/client.js", () => ({
  getDefaultDiscordClient: () => discordClient,
  getDiscordClientForGroupName: vi.fn().mockResolvedValue(discordClient),
  getDiscordClients: () => new Map([["personal", discordClient]]),
}));
const appendInboxMock = vi.hoisted(() => vi.fn());
vi.mock("../queue/repository.js", () => ({
  getQueueRepository: () => ({
    enqueue: appendInboxMock,
    findByIdempotencyKey: vi.fn().mockReturnValue(undefined),
  }),
}));
vi.mock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../utils/splitMessage.js", () => ({
  splitMessage: (s: string) => [s],
}));

const appendInbox = appendInboxMock;

import { NonRetryableError } from "../utils/error.js";
import { executeJob, loadHandlerFn, startCron, stopCron } from "./runner.js";

// --- loadHandlerFn: path traversal ---

describe("loadHandlerFn — path traversal", () => {
  it("throws for ../ traversal", async () => {
    await expect(loadHandlerFn("../evil.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("throws for ..\\\\ traversal (Windows-style)", async () => {
    await expect(loadHandlerFn("..\\evil.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("throws for embedded ../ in path", async () => {
    await expect(loadHandlerFn("jobs/../../evil.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });

  it("throws for absolute path outside project", async () => {
    await expect(loadHandlerFn("/etc/passwd.ts")).rejects.toBeInstanceOf(
      NonRetryableError,
    );
  });
});

// --- executeJob ---

describe("executeJob", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("direct + per-run: 指定先へ毎回独立したセッションで送る", async () => {
    await executeJob({
      id: "test-job",
      schedule: "* * * * *",
      enabled: true,
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      deliveryMode: "direct",
      sessionMode: "per-run",
    });

    expect(vi.mocked(appendInbox)).toHaveBeenCalledOnce();
    const arg = vi.mocked(appendInbox).mock.calls[0][0];
    expect(arg.channelId).toBe("ch-123");
    expect(arg.groupName).toBe("my-group");
    expect(arg.content).toBe("do something");
    expect(arg.sessionId).toMatch(/^cron-test-job-/);
    expect(arg.cronDeliveryMode).toBe("direct");
    expect(arg.cronSessionMode).toBe("per-run");
    expect(arg.cronJobId).toBe("test-job");
  });

  it("new-thread + destination: 新規スレッド用の設定をキューへ渡す", async () => {
    await executeJob({
      id: "test-job",
      schedule: "* * * * *",
      enabled: true,
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      deliveryMode: "new-thread",
      sessionMode: "destination",
    });

    expect(vi.mocked(appendInbox)).toHaveBeenCalledOnce();
    const arg = vi.mocked(appendInbox).mock.calls[0][0];
    expect(arg.channelId).toBe("ch-123");
    expect(arg.groupName).toBe("my-group");
    expect(arg.content).toBe("do something");
    expect(arg.sessionId).toMatch(/^cron-test-job-/);
    expect(arg.cronDeliveryMode).toBe("new-thread");
    expect(arg.cronSessionMode).toBe("destination");
    expect(arg.cronJobId).toBe("test-job");
  });

  it("item-thread + destination: item-threadをキューへ渡す", async () => {
    await executeJob({
      id: "item-job",
      schedule: "5m",
      enabled: true,
      groupName: "my-group",
      prompt: "summarize item",
      channelId: "ch-123",
      deliveryMode: "item-thread",
      sessionMode: "destination",
    });

    expect(vi.mocked(appendInbox)).toHaveBeenCalledWith(
      expect.objectContaining({
        cronDeliveryMode: "item-thread",
        cronSessionMode: "destination",
        cronThread: true,
        cronProvisioning: true,
        idempotencyKey: expect.stringMatching(/^cron-item:item-job:/),
      }),
    );
  });

  it("new-thread + destination: 実行ごとに異なる仮セッションをキューへ渡す", async () => {
    const job = {
      id: "repeated-job",
      schedule: "5m",
      enabled: true,
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      deliveryMode: "new-thread" as const,
      sessionMode: "destination" as const,
    };

    await executeJob(job);
    await executeJob(job);

    const sessionIds = vi
      .mocked(appendInbox)
      .mock.calls.map(([arg]) => arg.sessionId);
    expect(sessionIds).toHaveLength(2);
    expect(sessionIds[0]).toMatch(/^cron-repeated-job-/);
    expect(sessionIds[1]).toMatch(/^cron-repeated-job-/);
    expect(sessionIds[0]).not.toBe(sessionIds[1]);
  });

  it("direct + destination: 指定先IDをセッションIDとして使う", async () => {
    await executeJob({
      id: "test-job",
      schedule: "* * * * *",
      enabled: true,
      groupName: "my-group",
      prompt: "do something",
      channelId: "thread-123",
      deliveryMode: "direct",
      sessionMode: "destination",
    });

    const arg = vi.mocked(appendInbox).mock.calls[0][0];
    expect(arg.sessionId).toBe("thread-123");
  });

  it("旧 mode を新しい2軸へ変換する", async () => {
    await executeJob({
      id: "legacy-job",
      schedule: "* * * * *",
      enabled: true,
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      mode: "to-thread",
    });

    expect(vi.mocked(appendInbox)).toHaveBeenCalledWith(
      expect.objectContaining({
        cronDeliveryMode: "new-thread",
        cronSessionMode: "destination",
      }),
    );
  });
});

// --- startCron / stopCron ---

describe("startCron / stopCron", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    stopCron();
    vi.useRealTimers();
  });

  it("second startCron call is a no-op (no duplicate timers)", () => {
    startCron();
    const count = vi.getTimerCount();
    startCron();
    expect(vi.getTimerCount()).toBe(count);
  });

  it("stopCron clears all timers", () => {
    startCron();
    stopCron();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("can restart after stopCron", () => {
    startCron();
    stopCron();
    expect(vi.getTimerCount()).toBe(0);
    startCron();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  });
});
