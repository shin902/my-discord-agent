import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelToolApproval,
  claimToolApproval,
  clearToolApprovals,
  configureToolApprovalPresenter,
  consumeToolApproval,
  finalizeToolApproval,
  requestToolApproval,
  type ToolApprovalBinding,
  type ToolApprovalInteraction,
  type ToolApprovalRequest,
} from "./tool-approval-service.js";

const binding: ToolApprovalBinding = {
  runId: "run-1",
  operation: "comment-issue",
  invocation:
    '{"body":"approved body","issue_number":329,"owner":"shin902","repo":"my-discord-agent"}',
  target: "github:shin902/my-discord-agent#329",
};

let presented: ToolApprovalRequest[];

const validInteraction = (
  requestId: string,
  overrides: Partial<ToolApprovalInteraction> = {},
): ToolApprovalInteraction => ({
  requestId,
  decision: "approve",
  discordBotId: "personal",
  channelId: "channel-1",
  messageId: "message-1",
  userId: "operator-1",
  ...overrides,
});

function claimAndFinalize(
  interaction: ToolApprovalInteraction,
): ReturnType<typeof finalizeToolApproval> {
  const claim = claimToolApproval(interaction);
  return typeof claim === "string" ? claim : finalizeToolApproval(claim);
}

beforeEach(() => {
  presented = [];
  configureToolApprovalPresenter(async (request) => {
    presented.push(request);
    return {
      discordBotId: "personal",
      channelId: "channel-1",
      messageId: "message-1",
      authorizedUserIds: ["operator-1"],
    };
  });
});

afterEach(() => {
  clearToolApprovals();
  configureToolApprovalPresenter(undefined);
  vi.useRealTimers();
});

async function approvedToken(
  value: ToolApprovalBinding = binding,
): Promise<string> {
  const pending = requestToolApproval({
    ...value,
    groupName: "trusted",
    channelId: "channel-1",
    summary: "Post the exact comment",
  });
  const request = presented.at(-1);
  if (!request) throw new Error("approval was not presented");
  await vi.waitFor(() =>
    expect(claimAndFinalize(validInteraction(request.requestId))).toBe(
      "approved",
    ),
  );
  const token = await pending;
  if (!token) throw new Error("approval did not issue a token");
  return token;
}

describe("tool approval authority", () => {
  it("does not issue authority or resolve until a claim is finalized", async () => {
    let settled = false;
    const pending = requestToolApproval({
      ...binding,
      groupName: "trusted",
      channelId: "channel-1",
      summary: "wait for update",
    }).then((token) => {
      settled = true;
      return token;
    });
    const request = presented.at(-1);
    if (!request) throw new Error("approval was not presented");
    const claim = await vi.waitFor(() => {
      const result = claimToolApproval(validInteraction(request.requestId));
      if (typeof result === "string") throw new Error(result);
      return result;
    });

    expect(claim).toEqual({
      requestId: request.requestId,
      decision: "approve",
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    if (typeof claim === "string") throw new Error("approval was not claimed");
    expect(finalizeToolApproval(claim)).toBe("approved");
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("cancels a claimed request without issuing authority", async () => {
    const pending = requestToolApproval({
      ...binding,
      groupName: "trusted",
      channelId: "channel-1",
      summary: "Discord update failed",
    });
    const request = presented.at(-1);
    if (!request) throw new Error("approval was not presented");
    const claim = await vi.waitFor(() => {
      const result = claimToolApproval(validInteraction(request.requestId));
      if (typeof result === "string") throw new Error(result);
      return result;
    });

    expect(cancelToolApproval(claim)).toBe(true);
    expect(cancelToolApproval(claim)).toBe(false);
    await expect(pending).resolves.toBeUndefined();
  });

  it("claims and finalizes a concurrent click only once", async () => {
    const pending = requestToolApproval({
      ...binding,
      groupName: "trusted",
      channelId: "channel-1",
      summary: "single click",
    });
    const request = presented.at(-1);
    if (!request) throw new Error("approval was not presented");

    const first = await vi.waitFor(() => {
      const result = claimToolApproval(validInteraction(request.requestId));
      if (typeof result === "string") throw new Error(result);
      return result;
    });
    const replay = claimToolApproval(validInteraction(request.requestId));

    expect(replay).toBe("unknown");
    if (typeof first === "string") throw new Error("approval was not claimed");
    expect(finalizeToolApproval(first)).toBe("approved");
    expect(finalizeToolApproval(first)).toBe("unknown");
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("is issued only by a trusted decision and is single-use", async () => {
    const token = await approvedToken();

    expect(consumeToolApproval(token, binding)).toBe(true);
    expect(consumeToolApproval(token, binding)).toBe(false);
  });

  it.each([
    ["run", { ...binding, runId: "run-2" }],
    ["operation", { ...binding, operation: "delete-event" }],
    [
      "invocation",
      {
        ...binding,
        invocation: binding.invocation.replace("approved", "other"),
      },
    ],
    ["target", { ...binding, target: "github:shin902/other#329" }],
  ])("rejects a grant reused for another %s", async (_name, changed) => {
    const token = await approvedToken();

    expect(consumeToolApproval(token, changed)).toBe(false);
    expect(consumeToolApproval(token, binding)).toBe(false);
  });

  it("denial and timeout issue no authority", async () => {
    const denied = requestToolApproval({
      ...binding,
      groupName: "trusted",
      channelId: "channel-1",
      summary: "deny me",
    });
    await vi.waitFor(() =>
      expect(
        claimAndFinalize(
          validInteraction(presented[0]?.requestId ?? "", {
            decision: "deny",
          }),
        ),
      ).toBe("denied"),
    );
    await expect(denied).resolves.toBeUndefined();

    vi.useFakeTimers();
    const expired = requestToolApproval(
      {
        ...binding,
        groupName: "trusted",
        channelId: "channel-1",
        summary: "expire me",
      },
      10,
    );
    await vi.advanceTimersByTimeAsync(10);
    await expect(expired).resolves.toBeUndefined();
  });

  it.each([
    ["bot", { discordBotId: "other" }],
    ["channel", { channelId: "other" }],
    ["message", { messageId: "other" }],
    ["user", { userId: "other", decision: "deny" as const }],
  ])("does not consume a pending request for the wrong %s", async (_name, overrides) => {
    const pending = requestToolApproval({
      ...binding,
      groupName: "trusted",
      channelId: "channel-1",
      summary: "verify surface",
    });
    const request = presented.at(-1);
    if (!request) throw new Error("approval was not presented");
    await vi.waitFor(() =>
      expect(
        claimAndFinalize(validInteraction(request.requestId, overrides)),
      ).toBe("unauthorized"),
    );

    expect(claimAndFinalize(validInteraction(request.requestId))).toBe(
      "approved",
    );
    await expect(pending).resolves.toEqual(expect.any(String));
  });

  it("fails closed when the authorized user allowlist is empty", async () => {
    configureToolApprovalPresenter(async () => ({
      discordBotId: "personal",
      channelId: "channel-1",
      messageId: "message-1",
      authorizedUserIds: [],
    }));

    await expect(
      requestToolApproval({
        ...binding,
        groupName: "trusted",
        channelId: "channel-1",
        summary: "no approvers",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when no trusted presenter is configured", async () => {
    configureToolApprovalPresenter(undefined);

    await expect(
      requestToolApproval({
        ...binding,
        groupName: "trusted",
        channelId: "channel-1",
        summary: "not presented",
      }),
    ).resolves.toBeUndefined();
  });
});
