import type { MessageCreateOptions } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createToolApprovalRequest } from "../proxy/tool-approval.js";
import { createToolProxyRunAuthority } from "../proxy/tool-proxy-run-authority.js";

const mocks = vi.hoisted(() => ({
  getDiscordClient: vi.fn(),
}));

vi.mock("./client.js", () => ({
  getDiscordClient: mocks.getDiscordClient,
}));

const {
  presentToolApprovalRequest,
  routeToolApprovalInteraction,
  TOOL_APPROVAL_UPDATE_TIMEOUT_MS,
} = await import("./tool-approval.js");

function setupRequest(args: unknown = { eventId: "event-1" }) {
  const authority = createToolProxyRunAuthority({
    runId: "run-1",
    allowedCapabilities: ["delete-event"],
    approvalRequiredCapabilities: ["delete-event"],
    trustedDiscordDestination: {
      botId: "secondary",
      channelId: "channel-1",
    },
  });
  return {
    authority,
    request: createToolApprovalRequest(
      authority.snapshot,
      "delete-event",
      args,
    ),
  };
}

function buttonIds(payload: MessageCreateOptions): {
  approve: string;
  deny: string;
} {
  const row = payload.components?.[0];
  if (!row || !("toJSON" in row)) throw new Error("button row missing");
  const components = (
    row.toJSON() as { components: Array<{ custom_id?: string }> }
  ).components;
  const approve = components[0]?.custom_id;
  const deny = components[1]?.custom_id;
  if (!approve || !deny) throw new Error("approval buttons missing");
  return { approve, deny };
}

function interaction(
  customId: string,
  overrides: {
    bot?: boolean;
    botId?: string;
    channelId?: string;
    messageId?: string;
    update?: ReturnType<typeof vi.fn>;
  } = {},
) {
  return {
    customId,
    user: { bot: overrides.bot ?? false },
    channelId: overrides.channelId ?? "channel-1",
    message: { id: overrides.messageId ?? "message-1" },
    update: overrides.update ?? vi.fn().mockResolvedValue(undefined),
    botId: overrides.botId ?? "secondary",
  };
}

let send: ReturnType<typeof vi.fn>;
let fetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  send = vi.fn().mockResolvedValue({ id: "message-1" });
  fetch = vi.fn().mockResolvedValue({ send });
  mocks.getDiscordClient.mockReset().mockReturnValue({
    channels: { fetch },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("presentToolApprovalRequest", () => {
  it("uses the snapshotted bot/channel and shows generic canonical JSON with no mentions", async () => {
    const { authority, request } = setupRequest({
      eventId: "event-1",
      note: "<@123456789>",
    });

    await presentToolApprovalRequest(request);

    expect(mocks.getDiscordClient).toHaveBeenCalledWith("secondary");
    expect(fetch).toHaveBeenCalledWith("channel-1");
    expect(send).toHaveBeenCalledOnce();
    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    expect(payload.content).toContain("Tool: delete-event");
    expect(payload.content).toContain(request.invocation.args.json);
    expect(payload.content).not.toMatch(/summary|target|policy/i);
    expect(payload.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(payload.files).toBeUndefined();
    expect(buttonIds(payload).approve).toMatch(/^tool-approval:[^:]+:approve$/);
    expect(buttonIds(payload).deny).toMatch(/^tool-approval:[^:]+:deny$/);

    authority.revoke();
  });

  it("attaches the complete canonical JSON when inline content would exceed Discord limits", async () => {
    const { request } = setupRequest({ value: "x".repeat(2_100) });

    await presentToolApprovalRequest(request);

    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    expect(payload.content?.length).toBeLessThanOrEqual(2_000);
    expect(payload.content).toContain("attached as tool-approval-args.json");
    expect(payload.files).toHaveLength(1);
    const file = payload.files?.[0] as {
      attachment: Buffer;
      name: string;
    };
    expect(file.name).toBe("tool-approval-args.json");
    expect(file.attachment.toString("utf8")).toBe(request.invocation.args.json);

    const approve = interaction(buttonIds(payload).approve);
    await routeToolApprovalInteraction(approve as never, "secondary");
    expect(
      approve.update.mock.calls[0]?.[0].content.length,
    ).toBeLessThanOrEqual(2_000);
  });

  it("uses an attachment when canonical JSON could break the code block", async () => {
    const { authority, request } = setupRequest({ value: "```danger" });

    await presentToolApprovalRequest(request);

    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    expect(payload.files).toHaveLength(1);
    authority.revoke();
  });

  it("fails instead of falling back when the trusted channel is not sendable", async () => {
    fetch.mockResolvedValue({});
    const { authority, request } = setupRequest();

    await expect(presentToolApprovalRequest(request)).rejects.toThrow(
      "Tool approval Discord channel is not sendable: channel-1",
    );
    expect(send).not.toHaveBeenCalled();
    authority.revoke();
  });
});

describe("routeToolApprovalInteraction", () => {
  it("lets the first non-bot click win and updates to disabled Approved state", async () => {
    const { request } = setupRequest();
    await presentToolApprovalRequest(request);
    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    const ids = buttonIds(payload);
    let finishUpdate!: () => void;
    const updatePending = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    const approve = interaction(ids.approve, {
      update: vi.fn(() => updatePending),
    });
    const deny = interaction(ids.deny);

    const winningRoute = routeToolApprovalInteraction(
      approve as never,
      "secondary",
    );
    await vi.waitFor(() => expect(approve.update).toHaveBeenCalledOnce());
    await expect(
      routeToolApprovalInteraction(deny as never, "secondary"),
    ).resolves.toBe(false);
    expect(deny.update).not.toHaveBeenCalled();

    finishUpdate();
    await expect(winningRoute).resolves.toBe(true);
    await expect(request.waitForDecision()).resolves.toBe("approved");
    const updatePayload = approve.update.mock.calls[0]?.[0];
    expect(updatePayload.content).toContain("Result: Approved");
    expect(updatePayload.allowedMentions).toEqual({
      parse: [],
      repliedUser: false,
    });
    for (const component of updatePayload.components[0].toJSON().components) {
      expect(component.disabled).toBe(true);
    }
  });

  it("routes Deny and displays its terminal result", async () => {
    const { request } = setupRequest();
    await presentToolApprovalRequest(request);
    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    const deny = interaction(buttonIds(payload).deny);

    await expect(
      routeToolApprovalInteraction(deny as never, "secondary"),
    ).resolves.toBe(true);

    await expect(request.waitForDecision()).resolves.toBe("denied");
    expect(deny.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("Result: Denied"),
      }),
    );
  });

  it("does not consume mismatched bot/channel/message, bot users, or unknown components", async () => {
    const { request } = setupRequest();
    await presentToolApprovalRequest(request);
    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    const approveId = buttonIds(payload).approve;

    const attempts: Array<[ReturnType<typeof interaction>, string]> = [
      [interaction("other-component:value"), "secondary"],
      [interaction(approveId), "personal"],
      [interaction(approveId, { channelId: "channel-2" }), "secondary"],
      [interaction(approveId, { messageId: "message-2" }), "secondary"],
      [interaction(approveId, { bot: true }), "secondary"],
    ];
    for (const [candidate, botId] of attempts) {
      await expect(
        routeToolApprovalInteraction(candidate as never, botId),
      ).resolves.toBe(false);
      expect(candidate.update).not.toHaveBeenCalled();
      expect(request.state).toBe("pending");
    }

    const valid = interaction(approveId);
    await routeToolApprovalInteraction(valid as never, "secondary");
    await expect(request.waitForDecision()).resolves.toBe("approved");
  });

  it("fails closed when the claimed Discord update rejects", async () => {
    const { request } = setupRequest();
    await presentToolApprovalRequest(request);
    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    const updateError = new Error("Discord unavailable");
    const approve = interaction(buttonIds(payload).approve, {
      update: vi.fn().mockRejectedValue(updateError),
    });

    await expect(
      routeToolApprovalInteraction(approve as never, "secondary"),
    ).resolves.toBe(true);

    await expect(request.waitForDecision()).rejects.toMatchObject({
      name: "ToolApprovalUiUpdateError",
      cause: updateError,
    });
    expect(request.state).toBe("failed");
  });

  it("applies a short timeout only to the claimed Discord update and fails closed", async () => {
    vi.useFakeTimers();
    const { request } = setupRequest();
    await presentToolApprovalRequest(request);
    const payload = send.mock.calls[0]?.[0] as MessageCreateOptions;
    const approve = interaction(buttonIds(payload).approve, {
      update: vi.fn(() => new Promise(() => undefined)),
    });

    const routing = routeToolApprovalInteraction(approve as never, "secondary");
    await vi.advanceTimersByTimeAsync(TOOL_APPROVAL_UPDATE_TIMEOUT_MS);

    await expect(routing).resolves.toBe(true);
    await expect(request.waitForDecision()).rejects.toMatchObject({
      name: "ToolApprovalUiUpdateError",
      cause: expect.objectContaining({
        message: "Discord tool approval update timed out",
      }),
    });
    expect(request.state).toBe("failed");
  });
});
