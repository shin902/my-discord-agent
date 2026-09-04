import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configurePresenter: vi.fn(),
  decide: vi.fn(),
  fetchChannel: vi.fn(),
  findGroupByName: vi.fn(),
}));

vi.mock("../application/tool-approval-service.js", () => ({
  configureToolApprovalPresenter: mocks.configurePresenter,
  decideToolApproval: mocks.decide,
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
  mocks.decide.mockReturnValue("approved");
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

    const surface = await presenter({
      requestId: "a".repeat(32),
      runId: "run-1",
      operation: "comment-issue",
      invocation: "canonical",
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
    const row = send.mock.calls[0]?.[0].components[0].toJSON();
    expect(
      row.components.map((button: { label: string }) => button.label),
    ).toEqual(["Approve", "Deny"]);
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

    expect(mocks.decide).toHaveBeenCalledWith({
      requestId: "a".repeat(32),
      decision: "approve",
      discordBotId: "personal",
      channelId: "channel-1",
      messageId: "message-1",
      userId: "operator-1",
    });
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "approval request\nApproved by operator.",
        components: [expect.anything()],
      }),
    );
    const row = interaction.update.mock.calls[0]?.[0].components[0].toJSON();
    expect(
      row.components.every((button: { disabled?: boolean }) => button.disabled),
    ).toBe(true);
  });

  it("does not let a Discord bot approve", async () => {
    const interaction = {
      customId: `tool-approval:approve:${"a".repeat(32)}`,
      user: { id: "agent-1", bot: true, username: "agent" },
      reply: vi.fn().mockResolvedValue(undefined),
      update: vi.fn(),
    };

    await handleToolApprovalButton(interaction as never, "personal");

    expect(mocks.decide).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ ephemeral: true }),
    );
  });

  it("leaves the valid request active after an unauthorized click", async () => {
    mocks.decide.mockReturnValue("unauthorized");
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
