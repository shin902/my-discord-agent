import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSkillCommand: vi.fn(),
  executeBotCommand: vi.fn(),
}));

vi.mock("../application/discord-command-service.js", () => mocks);

const { handleBotCommand, handleSkillCommand } = await import(
  "./command-handlers.js"
);

function makeInteraction(options: Record<string, string | undefined>) {
  return {
    id: "interaction-1",
    channelId: "channel-1",
    channel: { isThread: () => false, parentId: null },
    user: { id: "user-1", bot: false },
    options: {
      getString: (name: string, _required?: boolean) => options[name] ?? null,
    },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.executeSkillCommand.mockResolvedValue("invalid");
  mocks.executeBotCommand.mockResolvedValue({
    content: "invalid",
    accepted: false,
  });
});

describe("Discord command adapter boundary", () => {
  it("passes a plain skill request to the application service", async () => {
    const interaction = makeInteraction({
      skill: "session-logs",
      prompt: "find",
    });

    await handleSkillCommand(interaction as never, "secondary");

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "invalid" });
    expect(mocks.executeSkillCommand).toHaveBeenCalledWith({
      discordBotId: "secondary",
      channelId: "channel-1",
      routingChannelId: "channel-1",
      isThread: false,
      skillName: "session-logs",
      prompt: "find",
      idempotencyKey: "discord-interaction:interaction-1",
      userId: "user-1",
      userIsBot: false,
    });
    expect(mocks.executeSkillCommand.mock.calls[0]?.[0]).not.toHaveProperty(
      "interaction",
    );
  });

  it("passes a plain Bot request to the application service", async () => {
    const interaction = makeInteraction({
      bot: "coding",
      action: "resume",
      prompt: "continue",
      session: "task-1234",
    });

    await handleBotCommand(interaction as never, "secondary");

    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({ content: "invalid" });
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(mocks.executeBotCommand).toHaveBeenCalledWith({
      discordBotId: "secondary",
      channelId: "channel-1",
      routingChannelId: "channel-1",
      botId: "coding",
      action: "resume",
      prompt: "continue",
      sessionHandle: "task-1234",
      idempotencyKey: "discord-interaction:interaction-1",
    });
  });
});
