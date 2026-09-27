import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerMailSource } from "../features/mail.js";
import { expectDefined } from "../test-utils.js";
import { QueueRepository } from "./repository.js";
import { SourceHandlers } from "./source-handlers.js";
import type { InboxMessage } from "./types.js";

describe("source registration", () => {
  it("uses registered Mail policy for terminal idempotency without interpreting email IDs", () => {
    const repo = new QueueRepository(":memory:");
    try {
      const handlers = new SourceHandlers();
      registerMailSource(handlers);
      repo.registerSources(handlers);
      const input = {
        channelId: "channel",
        groupName: "mail",
        sessionId: "session",
        content: "content",
        timestamp: new Date().toISOString(),
        idempotencyKey: "mail:one",
        feature: { kind: "mail", input: { emailId: "one" } },
      };
      const first = repo.enqueue(input).job;
      const claim = expectDefined(repo.claim());
      expect(claim.job.id).toBe(first.id);
      repo.commitResult(first.id, claim.fencingToken, "<NO_REPLY>", {
        suppressDelivery: true,
      });
      expect(repo.enqueue(input).job.id).not.toBe(first.id);
      expect(() =>
        repo.enqueue({ ...input, feature: { kind: "unknown", input: {} } }),
      ).toThrow(/unregistered/);
    } finally {
      repo.close();
    }
  });

  it("validates opaque input and refuses missing or duplicate registrations", async () => {
    const handlers = new SourceHandlers();
    const suppressed = vi.fn();
    handlers.register("mail", z.object({ emailId: z.string().min(1) }), {
      suppressed,
      activeOnlyIdempotency: true,
    });
    expect(() => handlers.register("mail", z.unknown(), {})).toThrow(
      /duplicate/,
    );
    expect(() => handlers.policy({ kind: "other", input: {} })).toThrow(
      /unregistered/,
    );
    expect(() => handlers.policy({ kind: "mail", input: {} })).toThrow(
      /invalid/,
    );
    expect(
      handlers.policy({ kind: "mail", input: { emailId: "one" } }),
    ).toEqual({
      activeOnlyIdempotency: true,
      continueAfterFailedChunk: false,
    });
    const message = {
      feature: { kind: "mail", input: { emailId: "one" } },
    } as InboxMessage;
    await handlers.suppressed(message);
    expect(suppressed).toHaveBeenCalledWith({ emailId: "one" }, message);
  });
});
