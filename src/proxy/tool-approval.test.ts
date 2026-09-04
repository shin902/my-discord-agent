import { describe, expect, it, vi } from "vitest";
import {
  createToolApprovalRequest,
  ToolApprovalCanceledError,
  ToolApprovalUiUpdateError,
} from "./tool-approval.js";
import { createToolProxyRunAuthority } from "./tool-proxy-run-authority.js";

function setup() {
  return createToolProxyRunAuthority({
    runId: "run-1",
    allowedCapabilities: ["delete-event", "read-event"],
    approvalRequiredCapabilities: ["delete-event"],
    trustedDiscordDestination: {
      botId: "personal",
      channelId: "channel-1",
    },
  });
}

describe("createToolApprovalRequest", () => {
  it("binds one run and capability to an immutable canonical JSON invocation", () => {
    const authority = setup();
    const materializedArgs = {
      eventId: "event-1",
      calendarId: "primary",
      nested: { confirm: true },
    };

    const request = createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      materializedArgs,
    );
    materializedArgs.calendarId = "other";
    materializedArgs.nested.confirm = false;

    expect(request.invocation).toMatchObject({
      runId: "run-1",
      capability: "delete-event",
      destination: { botId: "personal", channelId: "channel-1" },
      args: {
        value: {
          eventId: "event-1",
          calendarId: "primary",
          nested: { confirm: true },
        },
      },
    });
    expect(request.invocation.args.json).toBe(
      JSON.stringify(request.invocation.args.value, null, 2),
    );
    expect(() =>
      Object.assign(request.invocation.args.value as object, {
        calendarId: "other",
      }),
    ).toThrow(TypeError);
    expect(() =>
      Object.assign(
        (request.invocation.args.value as { nested: object }).nested,
        { confirm: false },
      ),
    ).toThrow(TypeError);
  });

  it("rejects requests outside the snapshotted approval authority", () => {
    const authority = setup();

    expect(() =>
      createToolApprovalRequest(authority.snapshot, "comment-issue", {}),
    ).toThrow("Capability is not authorized for this run: comment-issue");
    expect(() =>
      createToolApprovalRequest(authority.snapshot, "read-event", {}),
    ).toThrow("Capability does not require approval: read-event");
  });

  it("fails closed without a trusted Discord destination", () => {
    const authority = createToolProxyRunAuthority({
      runId: "cron-run",
      allowedCapabilities: ["delete-event"],
      approvalRequiredCapabilities: ["delete-event"],
    });

    expect(() =>
      createToolApprovalRequest(authority.snapshot, "delete-event", {}),
    ).toThrow(
      "Approval-required capability has no trusted Discord destination: delete-event",
    );
  });

  it("rejects non-JSON materialized arguments", () => {
    const authority = setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      createToolApprovalRequest(authority.snapshot, "delete-event", cyclic),
    ).toThrow("Materialized tool arguments must be JSON-serializable");
  });

  it("waits without an approval-specific deadline", async () => {
    vi.useFakeTimers();
    try {
      const authority = setup();
      const request = createToolApprovalRequest(
        authority.snapshot,
        "delete-event",
        {},
      );

      await vi.advanceTimersByTimeAsync(365 * 24 * 60 * 60 * 1_000);

      expect(request.state).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("atomically accepts only the first decision and approves after its UI update", async () => {
    const authority = setup();
    const request = createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      {},
    );

    const approval = request.claim("approve");
    const losingDecision = request.claim("deny");

    expect(approval).toBeDefined();
    expect(losingDecision).toBeUndefined();
    expect(request.state).toBe("claimed");
    expect(approval?.completeUiUpdate()).toBe(true);
    expect(approval?.completeUiUpdate()).toBe(false);
    await expect(request.waitForDecision()).resolves.toBe("approved");
    expect(request.state).toBe("approved");
  });

  it("settles denied only after a successful UI update", async () => {
    const authority = setup();
    const request = createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      {},
    );

    const denial = request.claim("deny");

    expect(request.state).toBe("claimed");
    expect(denial?.completeUiUpdate()).toBe(true);
    await expect(request.waitForDecision()).resolves.toBe("denied");
    expect(request.state).toBe("denied");
  });

  it("fails closed when the claimed UI update fails or times out", async () => {
    const authority = setup();
    const request = createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      {},
    );
    const updateFailure = new Error("Discord timeout");

    const approval = request.claim("approve");
    expect(approval?.failUiUpdate(updateFailure)).toBe(true);

    await expect(request.waitForDecision()).rejects.toMatchObject({
      name: "ToolApprovalUiUpdateError",
      cause: updateFailure,
    });
    expect(request.state).toBe("failed");
    expect(request.claim("approve")).toBeUndefined();
    expect(new ToolApprovalUiUpdateError()).toBeInstanceOf(Error);
  });

  it("cancels a pending request when run authority is revoked", async () => {
    const authority = setup();
    const request = createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      {},
    );

    authority.revoke();

    await expect(request.waitForDecision()).rejects.toBeInstanceOf(
      ToolApprovalCanceledError,
    );
    expect(request.state).toBe("canceled");
    expect(request.claim("approve")).toBeUndefined();
  });

  it("cancels a claimed request before its UI update completes", async () => {
    const authority = setup();
    const request = createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      {},
    );
    const approval = request.claim("approve");

    authority.revoke();

    expect(approval?.completeUiUpdate()).toBe(false);
    await expect(request.waitForDecision()).rejects.toBeInstanceOf(
      ToolApprovalCanceledError,
    );
    expect(request.state).toBe("canceled");
  });

  it("starts canceled when the authority was already revoked", async () => {
    const authority = setup();
    authority.revoke();

    const request = createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      {},
    );

    await expect(request.waitForDecision()).rejects.toBeInstanceOf(
      ToolApprovalCanceledError,
    );
    expect(request.state).toBe("canceled");
  });
});
