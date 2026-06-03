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

import { sendMessage } from "../agent/manager.js";
import { client } from "../discord/client.js";
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
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      mode: "channel",
    });

    expect(vi.mocked(appendInbox)).toHaveBeenCalledOnce();
    const arg = vi.mocked(appendInbox).mock.calls[0][0];
    expect(arg.channelId).toBe("ch-123");
    expect(arg.groupName).toBe("my-group");
    expect(arg.content).toBe("do something");
    expect(arg.sessionId).toMatch(/^cron-test-job-/);
  });

  it("thread mode: creates thread and calls sendMessage", async () => {
    const mockSend = vi.fn();
    const mockThread = { id: "thread-456", send: mockSend };
    const mockChannel = {
      threads: { create: vi.fn().mockResolvedValue(mockThread) },
    };
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockChannel,
    );
    vi.mocked(sendMessage).mockResolvedValue("result text");

    await executeJob({
      id: "test-job",
      schedule: "* * * * *",
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      mode: "thread",
    });

    expect(mockChannel.threads.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: expect.stringMatching(/^cron-test-job-/),
      }),
    );
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      "my-group",
      "thread-456",
      "do something",
    );
    expect(mockSend).toHaveBeenCalledWith("result text");
  });

  it("thread mode: does not call thread.send when sendMessage returns null", async () => {
    const mockSend = vi.fn();
    const mockThread = { id: "thread-789", send: mockSend };
    const mockChannel = {
      threads: { create: vi.fn().mockResolvedValue(mockThread) },
    };
    (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      mockChannel,
    );
    vi.mocked(sendMessage).mockResolvedValue("");

    await executeJob({
      id: "test-job",
      schedule: "* * * * *",
      groupName: "my-group",
      prompt: "do something",
      channelId: "ch-123",
      mode: "thread",
    });

    expect(mockSend).not.toHaveBeenCalled();
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
