import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../discord/client.js", () => ({
  client: {
    isReady: vi.fn(() => false),
    channels: { fetch: vi.fn() },
  },
}));
vi.mock("../queue/inbox.js", () => ({ appendInbox: vi.fn() }));
vi.mock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../utils/splitMessage.js", () => ({
  splitMessage: (s: string) => [s],
}));

import { appendInbox } from "../queue/inbox.js";
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

  it("channel mode: calls appendInbox with correct args", async () => {
    await executeJob({
      id: "test-job",
      schedule: "* * * * *",
      enabled: true,
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      mode: "to-channel",
    });

    expect(vi.mocked(appendInbox)).toHaveBeenCalledOnce();
    const arg = vi.mocked(appendInbox).mock.calls[0][0];
    expect(arg.channelId).toBe("ch-123");
    expect(arg.groupName).toBe("my-group");
    expect(arg.content).toBe("do something");
    expect(arg.sessionId).toMatch(/^cron-test-job-/);
    expect(arg.cronJobId).toBe("test-job");
  });

  it("to-thread mode: appendInbox に cronThread フラグとジョブIDを渡す", async () => {
    await executeJob({
      id: "test-job",
      schedule: "* * * * *",
      enabled: true,
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      mode: "to-thread",
    });

    expect(vi.mocked(appendInbox)).toHaveBeenCalledOnce();
    const arg = vi.mocked(appendInbox).mock.calls[0][0];
    expect(arg.channelId).toBe("ch-123");
    expect(arg.groupName).toBe("my-group");
    expect(arg.content).toBe("do something");
    expect(arg.sessionId).toBe("cron-test-job");
    expect(arg.cronThread).toBe(true);
    expect(arg.cronJobId).toBe("test-job");
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
