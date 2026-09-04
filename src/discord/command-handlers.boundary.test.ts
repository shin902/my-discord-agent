import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeSkillCommand: vi.fn(),
  executeBotCommand: vi.fn(),
  executeSteerCommand: vi.fn(),
}));

vi.mock("../application/discord-command-service.js", () => mocks);

const { handleBotCommand, handleSkillCommand, handleSteerCommand } =
  await import("./command-handlers.js");

function makeInteraction(options: Record<string, string | undefined>) {
  return {
    id: "interaction-1",
    channelId: "channel-1",
    channel: {
      isThread: () => false,
      parentId: null,
      send: vi.fn().mockResolvedValue(undefined),
    },
    user: { id: "user-1", bot: false },
    options: {
      getString: (name: string, _required?: boolean) => options[name] ?? null,
    },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    deleteReply: vi.fn().mockResolvedValue(undefined),
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
  mocks.executeSteerCommand.mockResolvedValue({
    content: "invalid",
    accepted: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it("posts an accepted Bot receipt independently and removes the ACK", async () => {
    mocks.executeBotCommand.mockResolvedValue({
      content: "Botへの依頼を受け付けました。Task Session: task-1234",
      accepted: true,
    });
    const interaction = makeInteraction({
      bot: "coding",
      action: "run",
      prompt: "do it",
    });

    await handleBotCommand(interaction as never, "secondary");

    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.channel.send).toHaveBeenCalledWith({
      content:
        "Bot: coding\nPrompt: do it\nBotへの依頼を受け付けました。Task Session: task-1234",
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
  });

  it("keeps an accepted command successful when ACK cleanup fails", async () => {
    mocks.executeBotCommand.mockResolvedValue({
      content: "Botへの依頼を受け付けました。Task Session: task-1234",
      accepted: true,
    });
    const cleanupError = new Error("ephemeral reply already removed");
    const interaction = makeInteraction({
      bot: "coding",
      action: "resume",
      prompt: "continue",
      session: "task-1234",
    });
    interaction.deleteReply.mockRejectedValue(cleanupError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handleBotCommand(interaction as never, "secondary"),
    ).resolves.toBe(undefined);

    expect(interaction.channel.send).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "[handler] Bot receipt ACK cleanup failed:",
      cleanupError,
    );
  });

  it("posts an accepted steer instruction as an independent public message", async () => {
    const instruction = "Please ping <@123> and adjust";
    mocks.executeSteerCommand.mockResolvedValue({
      content: "実行中Agentへ方針転換を送りました。",
      accepted: true,
      instruction,
    });
    const interaction = makeInteraction({ instruction });

    await handleSteerCommand(interaction as never, "secondary");

    expect(interaction.editReply).not.toHaveBeenCalled();
    expect(interaction.channel.send).toHaveBeenCalledWith({
      content: `Steer:\n${instruction}`,
      allowedMentions: { parse: [], repliedUser: false },
    });
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
  });

  it("keeps an accepted steer successful when ACK cleanup fails", async () => {
    const instruction = "Please continue";
    mocks.executeSteerCommand.mockResolvedValue({
      content: "実行中Agentへ方針転換を送りました。",
      accepted: true,
      instruction,
    });
    const cleanupError = new Error("ephemeral reply already removed");
    const interaction = makeInteraction({ instruction });
    interaction.deleteReply.mockRejectedValue(cleanupError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      handleSteerCommand(interaction as never, "secondary"),
    ).resolves.toBe(undefined);

    expect(interaction.channel.send).toHaveBeenCalledOnce();
    expect(interaction.deleteReply).toHaveBeenCalledOnce();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "[handler] Steer receipt ACK cleanup failed:",
      cleanupError,
    );
  });

  it("keeps rejected steer results ephemeral", async () => {
    const interaction = makeInteraction({ instruction: "No active run" });

    await handleSteerCommand(interaction as never, "secondary");

    expect(interaction.editReply).toHaveBeenCalledWith({ content: "invalid" });
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
  });

  it("splits a long steer receipt and disables mention expansion", async () => {
    const instruction = "x".repeat(4_000);
    mocks.executeSteerCommand.mockResolvedValue({
      content: "実行中Agentへ方針転換を送りました。",
      accepted: true,
      instruction,
    });
    const interaction = makeInteraction({ instruction });

    await handleSteerCommand(interaction as never);

    const chunks = interaction.channel.send.mock.calls.map(
      ([options]) => (options as { content: string }).content,
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
    expect(chunks.join("")).toContain(instruction);
    expect(interaction.followUp).not.toHaveBeenCalled();
    for (const [options] of interaction.channel.send.mock.calls) {
      expect(options).toEqual({
        content: expect.any(String),
        allowedMentions: { parse: [], repliedUser: false },
      });
    }
  });

  it("fails accepted steer receipts when the channel cannot send", async () => {
    const instruction = "Please continue";
    mocks.executeSteerCommand.mockResolvedValue({
      content: "実行中Agentへ方針転換を送りました。",
      accepted: true,
      instruction,
    });
    const interaction = makeInteraction({ instruction });
    Object.assign(interaction.channel, { send: undefined });

    await expect(handleSteerCommand(interaction as never)).rejects.toThrow(
      "Steer receipt destination is unavailable",
    );
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.deleteReply).not.toHaveBeenCalled();
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
    expect(interaction.deleteReply).not.toHaveBeenCalled();
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
