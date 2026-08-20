import { describe, expect, it, vi, afterEach } from "vitest";
import { NonRetryableError } from "../utils/error.js";
import { createCronRunner } from "./runner.js";

const appendInbox = vi.fn().mockResolvedValue(undefined);
const client = Object.create(null);
const runner = createCronRunner({ appendInbox, getDefaultDiscordClient: () => client, getDiscordClientForGroupName: async () => client });

describe("cron runner integration", () => {
  it.each(["../evil.ts", "..\\evil.ts", "jobs/../../evil.ts", "/etc/passwd.ts"])("rejects unsafe handler %s", async (path) => {
    await expect(runner.loadHandlerFn(path)).rejects.toBeInstanceOf(NonRetryableError);
  });
  it("enqueues direct per-run jobs", async () => {
    appendInbox.mockClear();
    await runner.executeJob({ id: "direct", schedule: "* * * * *", enabled: true, groupName: "g", prompt: "do", channelId: "ch", deliveryMode: "direct", sessionMode: "per-run" });
    expect(appendInbox).toHaveBeenCalledWith(expect.objectContaining({ channelId: "ch", content: "do", cronDeliveryMode: "direct", cronSessionMode: "per-run", cronJobId: "direct" }));
  });
  it("uses destination as the session for direct destination jobs", async () => {
    appendInbox.mockClear();
    await runner.executeJob({ id: "destination", schedule: "* * * * *", enabled: true, groupName: "g", prompt: "do", channelId: "thread", deliveryMode: "direct", sessionMode: "destination" });
    expect(appendInbox).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "thread" }));
  });
  it("translates legacy thread mode", async () => {
    appendInbox.mockClear();
    await runner.executeJob({ id: "legacy", schedule: "* * * * *", enabled: true, groupName: "g", prompt: "do", channelId: "ch", mode: "to-thread" });
    expect(appendInbox).toHaveBeenCalledWith(expect.objectContaining({ cronDeliveryMode: "new-thread", cronSessionMode: "destination" }));
  });
  it("creates and clears one timer", () => {
    vi.useFakeTimers(); runner.startCron(); const count = vi.getTimerCount(); runner.startCron(); expect(vi.getTimerCount()).toBe(count); runner.stopCron(); expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();
  });
  afterEach(() => { appendInbox.mockClear(); runner.stopCron(); });
});
