import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  claim: vi.fn(),
  configurePresenter: vi.fn(),
  finalize: vi.fn(),
  fetchChannel: vi.fn(),
  findGroupByName: vi.fn(),
}));

vi.mock("../application/tool-approval-service.js", () => ({
  cancelToolApproval: mocks.cancel,
  claimToolApproval: mocks.claim,
  configureToolApprovalPresenter: mocks.configurePresenter,
  finalizeToolApproval: mocks.finalize,
}));
vi.mock("../config/constants.js", () => ({
  DEFAULT_DISCORD_BOT_ID: "personal",
}));
vi.mock("../config/groups.js", () => ({
  findGroupByName: mocks.findGroupByName,
}));
vi.mock("./client.js", () => ({
  getDiscordClient: vi.fn(() => ({
    channels: { fetch: mocks.fetchChannel },
  })),
}));

const { handleToolApprovalButton, initializeDiscordToolApproval } =
  await import("./tool-approval.js");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claim.mockReturnValue({
    requestId: "a".repeat(32),
    decision: "approve",
  });
  mocks.finalize.mockReturnValue("approved");
  mocks.findGroupByName.mockResolvedValue({
    name: "trusted",
    bot: "personal",
    approvalUserIds: ["operator-1"],
  });
});

describe("Discord tool approval adapter", () => {
  it("presents immutable operation details with Approve and Deny buttons", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "message-1",
      channelId: "channel-1",
    });
    mocks.fetchChannel.mockResolvedValue({ isSendable: () => true, send });
    initializeDiscordToolApproval();
    const presenter = mocks.configurePresenter.mock.calls[0]?.[0] as (
      request: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;

    const canonicalInvocation =
      '{"body":"keep  exact spacing","issue_number":329}';
    const surface = await presenter({
      requestId: "a".repeat(32),
      runId: "run-1",
      operation: "comment-issue",
      invocation: canonicalInvocation,
      target: "github:shin902/my-discord-agent#329",
      groupName: "trusted",
      channelId: "channel-1",
      summary: "Comment: reviewed",
      expiresAt: 2_000_000_000_000,
    });

    expect(surface).toEqual({
      discordBotId: "personal",
      channelId: "channel-1",
      messageId: "message-1",
      authorizedUserIds: ["operator-1"],
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining(
          "Target: github:shin902/my-discord-agent#329",
        ),
        components: [expect.anything()],
        allowedMentions: { parse: [] },
      }),
    );
    const message = send.mock.calls[0]?.[0];
    expect(message.content).toContain(
      "Invocation (canonical normalized JSON):",
    );
    expect(message.content).toContain(canonicalInvocation);
    expect(message.files).toBeUndefined();
    const row = send.mock.calls[0]?.[0].components[0].toJSON();
    expect(
      row.components.map((button: { label: string }) => button.label),
    ).toEqual(["Approve", "Deny"]);
  });

  it("attaches the complete invocation when the Discord body cannot contain it", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "message-1",
      channelId: "channel-1",
    });
    mocks.fetchChannel.mockResolvedValue({ isSendable: () => true, send });
    initializeDiscordToolApproval();
    const presenter = mocks.configurePresenter.mock.calls[0]?.[0] as (
      request: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const invocation = JSON.stringify({ body: "x".repeat(2_100) });

    await presenter({
      requestId: "a".repeat(32),
      runId: "run-1",
      operation: "comment-issue",
      invocation,
      target: "github:shin902/my-discord-agent#329",
      groupName: "trusted",
      channelId: "channel-1",
      summary: "Comment: short summary",
      expiresAt: 2_000_000_000_000,
    });

    const message = send.mock.calls[0]?.[0];
    expect(message.content.length).toBeLessThanOrEqual(2_000);
    expect(message.content).toContain(
      "Complete canonical normalized invocation attached as approval-request.json.",
    );
    expect(message.files).toHaveLength(1);
    expect(message.files[0].name).toBe("approval-request.json");
    expect(message.files[0].attachment.toString("utf8")).toBe(invocation);
    expect(message.allowedMentions).toEqual({ parse: [] });
  });

  it("accepts only a well-formed Discord button identifier and disables replay", async () => {
    const interaction = {
      customId: `tool-approval:approve:${"a".repeat(32)}`,
      channelId: "channel-1",
      user: { id: "operator-1", bot: false, username: "operator" },
      message: { id: "message-1", content: "approval request" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn(),
    };

    await expect(
      handleToolApprovalButton(interaction as never, "personal"),
    ).resolves.toBe(true);

    expect(mocks.claim).toHaveBeenCalledWith({
      requestId: "a".repeat(32),
      decision: "approve",
      discordBotId: "personal",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "operator-1",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "approval request\nApproved.",
        components: [expect.anything()],
      }),
    );
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "a".repeat(32),
        decision: "approve",
      }),
    );
    const row = interaction.update.mock.calls[0]?.[0].components[0].toJSON();
    expect(
      row.components.every((button: { disabled?: boolean }) => button.disabled),
    ).toBe(true);
  });

  it("uses fixed denied status text", async () => {
    mocks.claim.mockReturnValue({
      requestId: "a".repeat(32),
      decision: "deny",
    });
    const interaction = {
      customId: `tool-approval:deny:${"a".repeat(32)}`,
      channelId: "channel-1",
      user: { id: "operator-1", bot: false, username: "operator" },
      message: { id: "message-1", content: "approval request" },
      update: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn(),
    };

    await handleToolApprovalButton(interaction as never, "personal");

    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: "approval request\nDenied." }),
    );
    expect(mocks.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny" }),
    );
  });

  it("does not let a Discord bot approve", async () => {
    const interaction = {
      customId: `tool-approval:approve:${"a".repeat(32)}`,
      user: { id: "agent-1", bot: true, username: "agent" },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    };

    await handleToolApprovalButton(interaction as never, "personal");

    expect(mocks.claim).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("fails closed when Discord cannot update the approval message", async () => {
    const claim = { requestId: "a".repeat(32), decision: "approve" };
    mocks.claim.mockReturnValue(claim);
    const interaction = {
      customId: `tool-approval:approve:${"a".repeat(32)}`,
      channelId: "channel-1",
      user: { id: "operator-1", bot: false, username: "operator" },
      message: { id: "message-1", content: "approval request" },
      update: vi.fn().mockRejectedValue(new Error("Discord unavailable")),
      reply: vi.fn(),
    };

    await expect(
      handleToolApprovalButton(interaction as never, "personal"),
    ).resolves.toBe(true);

    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledWith(claim);
  });

  it("reserves room for terminal status at the Discord content limit", async () => {
    const send = vi.fn().mockResolvedValue({
      id: "message-1",
      channelId: "channel-1",
    });
    mocks.fetchChannel.mockResolvedValue({ isSendable: () => true, send });
    initializeDiscordToolApproval();
    const presenter = mocks.configurePresenter.mock.calls[0]?.[0] as (
      request: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const invocation = "x".repeat(1_850);

    await presenter({
      requestId: "a".repeat(32),
      runId: "run-1",
      operation: "comment-issue",
      invocation,
      target: "target",
      groupName: "trusted",
      channelId: "channel-1",
      summary: "summary that must be truncated",
      expiresAt: 2_000_000_000_000,
    });

    const content = send.mock.calls[0]?.[0].content as string;
    expect(content.length + "\nApproved.".length).toBeLessThanOrEqual(2_000);
  });

  it("leaves the valid request active after an unauthorized click", async () => {
    mocks.claim.mockReturnValue("unauthorized");
    const interaction = {
      customId: `tool-approval:approve:${"a".repeat(32)}`,
      channelId: "wrong-channel",
      user: { id: "wrong-user", bot: false, username: "intruder" },
      message: { id: "wrong-message", content: "copied button" },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    };

    await handleToolApprovalButton(interaction as never, "wrong-bot");

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
    expect(interaction.update).not.toHaveBeenCalled();
  });
});
