import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../discord/client.js", () => ({
  client: {
    isReady: vi.fn(() => false),
    channels: { fetch: vi.fn() },
  },
}));
const appendInboxMock = vi.hoisted(() => vi.fn());
vi.mock("../queue/repository.js", () => ({
  getQueueRepository: () => ({ enqueue: appendInboxMock }),
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
    expect(arg.sessionId).toBe("cron-test-job");
    expect(arg.cronDeliveryMode).toBe("new-thread");
    expect(arg.cronSessionMode).toBe("destination");
    expect(arg.cronJobId).toBe("test-job");
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
