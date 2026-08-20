import { describe, expect, it, vi, afterEach } from "vitest";
import { createCronRunner } from "./runner.js";

function harness() {
  const isReady = vi.fn(() => true);
  const appendInbox = vi.fn().mockResolvedValue(undefined);
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const runner = createCronRunner({
    getDiscordClients: () => new Map(),
    appendInbox,
    existsSync: () => false,
    writeFile,
    mkdir: vi.fn().mockResolvedValue(undefined),
  });
  return { runner, isReady, appendInbox, writeFile };
}

afterEach(() => vi.useRealTimers());

describe("tick orchestration", () => {
  it("skips when no client is ready", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2025-01-15T12:29:50Z"));
    const h = harness(); h.isReady.mockReturnValue(false);
    h.runner.setCronJobs([{ id: "not-ready", schedule: "* * * * *", enabled: true, groupName: "g", prompt: "p", channelId: "c", deliveryMode: "direct", sessionMode: "per-run" }]);
    h.runner.startCron(); await vi.advanceTimersByTimeAsync(10_000); h.runner.stopCron();
    expect(h.appendInbox).not.toHaveBeenCalled();
  });
  it("starts a single aligned scheduler timer", () => {
    vi.useFakeTimers();
    const h = harness();
    h.runner.setCronJobs([{ id: "runs", schedule: "* * * * *", enabled: true, groupName: "g", prompt: "p", channelId: "c", deliveryMode: "direct", sessionMode: "per-run" }]);
    h.runner.startCron();
    const count = vi.getTimerCount();
    h.runner.startCron();
    expect(count).toBe(1);
    expect(vi.getTimerCount()).toBe(count);
    h.runner.stopCron();
  });
  it("does not save state for transient errors but does for non-retryable errors", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2025-01-15T12:29:50Z"));
    const transient = harness(); transient.appendInbox.mockRejectedValue(new Error("temporary"));
    transient.runner.setCronJobs([{ id: "transient", schedule: "* * * * *", enabled: true, groupName: "g", prompt: "p", channelId: "c", deliveryMode: "direct", sessionMode: "per-run" }]);
    transient.runner.startCron(); await vi.advanceTimersByTimeAsync(10_000); transient.runner.stopCron(); expect(transient.writeFile).not.toHaveBeenCalled();
  });
  it("does nothing when jobs are empty", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2025-01-15T12:29:50Z"));
    const h = harness(); h.runner.setCronJobs([]); h.runner.startCron(); await vi.advanceTimersByTimeAsync(10_000); h.runner.stopCron();
    expect(h.appendInbox).not.toHaveBeenCalled();
  });
});
