import { describe, expect, it, vi } from "vitest";
import { JobHandlers } from "./job-handlers.js";
import type { InboxMessage } from "./types.js";

describe("host job registration", () => {
  it("runs only explicitly registered kinds and rejects duplicate registrations", async () => {
    const handlers = new JobHandlers();
    const run = vi.fn();
    handlers.register("memory-export", run);
    expect(() => handlers.register("memory-export", run)).toThrow(/duplicate/);
    const message: InboxMessage = {
      id: "job-1",
      jobKind: "memory-export",
      channelId: "",
      groupName: "",
      sessionId: "memory-export:one",
      content: "",
      timestamp: new Date().toISOString(),
      retries: 0,
    };
    await expect(
      handlers.run({ ...message, jobKind: "unknown" }),
    ).rejects.toThrow(/unregistered/);
    expect(run).not.toHaveBeenCalled();
    await handlers.run(message);
    expect(run).toHaveBeenCalledWith(message, undefined);
  });
});
