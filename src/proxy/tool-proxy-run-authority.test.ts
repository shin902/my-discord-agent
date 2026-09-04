import { describe, expect, it } from "vitest";
import { createToolProxyRunAuthority } from "./tool-proxy-run-authority.js";

describe("createToolProxyRunAuthority", () => {
  it("copies capability selections and the trusted Discord destination", () => {
    const allowed = ["read-email", "delete-event"];
    const approvalRequired = ["delete-event"];
    const destination = { botId: "personal", channelId: "channel-1" };

    const authority = createToolProxyRunAuthority({
      runId: "run-1",
      allowedCapabilities: allowed,
      approvalRequiredCapabilities: approvalRequired,
      trustedDiscordDestination: destination,
    });

    allowed.push("comment-issue");
    approvalRequired[0] = "read-email";
    destination.botId = "other";
    destination.channelId = "channel-2";

    expect(authority.snapshot.runId).toBe("run-1");
    expect([...authority.snapshot.allowedCapabilities]).toEqual([
      "read-email",
      "delete-event",
    ]);
    expect([...authority.snapshot.approvalRequiredCapabilities]).toEqual([
      "delete-event",
    ]);
    expect(authority.snapshot.trustedDiscordDestination?.botId).toBe(
      "personal",
    );
    expect(authority.snapshot.trustedDiscordDestination?.channelId).toBe(
      "channel-1",
    );
    expect(() =>
      Object.assign(authority.snapshot, { runId: "replacement" }),
    ).toThrow(TypeError);
    expect(() =>
      Object.assign(authority.snapshot.trustedDiscordDestination ?? {}, {
        channelId: "replacement",
      }),
    ).toThrow(TypeError);
    expect(() =>
      (authority.snapshot.allowedCapabilities as Set<string>).add(
        "comment-issue",
      ),
    ).toThrow(TypeError);
  });

  it("represents a run without a trusted Discord destination explicitly", () => {
    const authority = createToolProxyRunAuthority({
      runId: "cron-run",
      allowedCapabilities: ["delete-event"],
      approvalRequiredCapabilities: ["delete-event"],
    });

    expect(authority.snapshot.trustedDiscordDestination).toBeNull();
    expect(authority.snapshot.revokeSignal.aborted).toBe(false);
  });

  it("aborts the run-scoped revoke signal idempotently", () => {
    const authority = createToolProxyRunAuthority({
      runId: "run-1",
      allowedCapabilities: [],
    });
    const abort = new Promise<void>((resolve) => {
      authority.snapshot.revokeSignal.addEventListener(
        "abort",
        () => resolve(),
        {
          once: true,
        },
      );
    });

    authority.revoke();
    authority.revoke();

    expect(authority.snapshot.revokeSignal.aborted).toBe(true);
    return expect(abort).resolves.toBeUndefined();
  });

  it("rejects approval authority outside the run's allowed capabilities", () => {
    expect(() =>
      createToolProxyRunAuthority({
        runId: "run-1",
        allowedCapabilities: ["read-email"],
        approvalRequiredCapabilities: ["delete-event"],
      }),
    ).toThrow(
      "Approval-required capability is not allowed for this run: delete-event",
    );
  });
});
