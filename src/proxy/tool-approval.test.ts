import { describe, expect, it, vi } from "vitest";
import {
  createToolApprovalRequest,
  type ToolApprovalRequestInput,
} from "./tool-approval.js";

function input(
  controller = new AbortController(),
): ToolApprovalRequestInput & { controller: AbortController } {
  return {
    runId: "run-1",
    capability: "delete-event",
    trustedDiscordDestination: { botId: "personal", channelId: "channel-1" },
    revokeSignal: controller.signal,
    controller,
  };
}

describe("createToolApprovalRequest", () => {
  it("snapshots canonical args and destination immutably", () => {
    const requestInput = input();
    const args = { eventId: "event-1", nested: { confirm: true } };
    const request = createToolApprovalRequest(requestInput, args);

    args.eventId = "changed";
    args.nested.confirm = false;
    (requestInput.trustedDiscordDestination as { botId: string }).botId =
      "changed";

    expect(request.invocation).toEqual({
      runId: "run-1",
      capability: "delete-event",
      trustedDiscordDestination: { botId: "personal", channelId: "channel-1" },
      args: {
        value: { eventId: "event-1", nested: { confirm: true } },
        json: JSON.stringify(
          { eventId: "event-1", nested: { confirm: true } },
          null,
          2,
        ),
      },
    });
    expect(() => {
      (request.invocation.args.value as { eventId: string }).eventId = "x";
    }).toThrow(TypeError);
    expect(() => {
      (
        request.invocation.trustedDiscordDestination as { botId: string }
      ).botId = "x";
    }).toThrow(TypeError);
  });

  it("rejects arguments that cannot be canonicalized as JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => createToolApprovalRequest(input(), cyclic)).toThrow(
      "Materialized tool arguments must be JSON-serializable",
    );
    expect(() => createToolApprovalRequest(input(), undefined)).toThrow(
      "Materialized tool arguments must be JSON-serializable",
    );
  });

  it("accepts only the first claim and settles after a successful update", async () => {
    const request = createToolApprovalRequest(input(), { eventId: "event-1" });
    const approval = request.claim("approve");

    expect(approval).toBeDefined();
    expect(request.claim("deny")).toBeUndefined();
    expect(approval?.completeUiUpdate()).toBe(true);
    expect(approval?.completeUiUpdate()).toBe(false);
    await expect(request.waitForDecision()).resolves.toBe("approved");
  });

  it("settles a denial only after a successful update", async () => {
    const request = createToolApprovalRequest(input(), {});
    const denial = request.claim("deny");

    expect(request.waitForDecision()).toBeInstanceOf(Promise);
    expect(denial?.completeUiUpdate()).toBe(true);
    await expect(request.waitForDecision()).resolves.toBe("denied");
  });

  it("observes presenter-time rejection before the caller awaits it", async () => {
    const requestInput = input();
    const request = createToolApprovalRequest(requestInput, {});
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      requestInput.controller.abort(new Error("run stopped"));
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();
      await expect(request.waitForDecision()).rejects.toThrow(
        "Tool approval canceled because run authority was revoked",
      );
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("rejects when the Discord update fails", async () => {
    const request = createToolApprovalRequest(input(), {});
    const reason = new Error("Discord timeout");
    const claim = request.claim("approve");

    expect(claim?.failUiUpdate(reason)).toBe(true);
    expect(claim?.failUiUpdate()).toBe(false);
    await expect(request.waitForDecision()).rejects.toMatchObject({
      message: "Tool approval Discord update failed",
      cause: reason,
    });
  });

  it.each([
    "pending",
    "claimed",
  ] as const)("rejects when run authority is revoked while %s", async (phase) => {
    const requestInput = input();
    const request = createToolApprovalRequest(requestInput, {});
    if (phase === "claimed") request.claim("approve");

    requestInput.controller.abort(new Error("run stopped"));

    await expect(request.waitForDecision()).rejects.toMatchObject({
      message: "Tool approval canceled because run authority was revoked",
    });
  });

  it("rejects immediately when the signal was already aborted", async () => {
    const requestInput = input();
    requestInput.controller.abort();
    const request = createToolApprovalRequest(requestInput, {});

    await expect(request.waitForDecision()).rejects.toThrow(
      "Tool approval canceled because run authority was revoked",
    );
    expect(request.claim("approve")).toBeUndefined();
  });

  it("has no approval-specific timer while pending", async () => {
    vi.useFakeTimers();
    try {
      const requestInput = input();
      const request = createToolApprovalRequest(requestInput, {});
      await vi.advanceTimersByTimeAsync(365 * 24 * 60 * 60 * 1_000);
      expect(request.claim("deny")).toBeDefined();
      requestInput.controller.abort();
      await expect(request.waitForDecision()).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
