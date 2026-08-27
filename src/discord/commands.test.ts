import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGroupByChannelId: vi.fn(),
  loadBotRegistry: vi.fn(),
  resolveBotProfile: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("../config/groups.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/groups.js")>();
  return { ...actual, findGroupByChannelId: mocks.findGroupByChannelId };
});
vi.mock("../config/bots.js", () => ({
  loadBotRegistry: mocks.loadBotRegistry,
  resolveBotProfile: mocks.resolveBotProfile,
}));
vi.mock("../queue/repository.js", () => ({
  getQueueRepository: () => ({ enqueue: mocks.enqueue }),
}));

const { BOT_COMMAND, handleBotCommand, synchronizeBotCommand } = await import(
  "./commands.js"
);

function makeInteraction(options: {
  bot?: string;
  prompt?: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string | null;
}) {
  return {
    id: "interaction-1",
    channelId: options.channelId ?? "channel-1",
    channel: {
      isThread: () => options.isThread ?? false,
      parentId: options.parentId ?? null,
    },
    options: {
      getString: (name: string) =>
        name === "bot"
          ? (options.bot ?? "coding")
          : (options.prompt ?? "Do it"),
    },
    deferred: false,
    replied: false,
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findGroupByChannelId.mockResolvedValue({
    group: { name: "main" },
    channel: {
      channelId: "channel-1",
      sessionMode: "shared",
      model: { provider: "channel-provider", modelId: "channel-model" },
    },
  });
  mocks.loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
  mocks.resolveBotProfile.mockReturnValue({
    group: "main",
    instructions: "Act as coding worker",
    model: { provider: "bot-provider", modelId: "bot-model" },
  });
  mocks.enqueue.mockResolvedValue(undefined);
});

describe("BOT_COMMAND", () => {
  it("defines required bot and prompt string options", () => {
    const json = BOT_COMMAND.toJSON();
    expect(json.name).toBe("bot");
    expect(json.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bot", type: 3, required: true }),
        expect.objectContaining({ name: "prompt", type: 3, required: true }),
      ]),
    );
  });
});

describe("synchronizeBotCommand", () => {
  it("registers the /bot command on the application", async () => {
    const set = vi.fn().mockResolvedValue(undefined);

    await synchronizeBotCommand({
      application: { commands: { set } },
    } as never);

    expect(set).toHaveBeenCalledWith([BOT_COMMAND.toJSON()]);
  });
});

describe("handleBotCommand", () => {
  it("enqueues a one-shot Bot request without channel config inheritance", async () => {
    const interaction = makeInteraction({ bot: "coding", prompt: "Fix it" });

    await handleBotCommand(interaction as never);

    expect(mocks.findGroupByChannelId).toHaveBeenCalledWith("channel-1");
    expect(mocks.resolveBotProfile).toHaveBeenCalledWith(
      expect.anything(),
      "coding",
      "main",
    );
    expect(mocks.enqueue).toHaveBeenCalledWith({
      channelId: "channel-1",
      groupName: "main",
      sessionId: "channel-1",
      content: "Fix it",
      timestamp: expect.any(String),
      idempotencyKey: "discord-interaction:interaction-1",
      botId: "coding",
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Botへの依頼を受け付けました。",
    });
  });

  it("resolves a thread command through its parent channel", async () => {
    const interaction = makeInteraction({
      isThread: true,
      parentId: "parent-channel",
    });

    await handleBotCommand(interaction as never);

    expect(mocks.findGroupByChannelId).toHaveBeenCalledWith("parent-channel");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "channel-1",
        sessionId: "channel-1",
      }),
    );
  });

  it("returns an ephemeral error for an unknown or cross-group Bot", async () => {
    mocks.resolveBotProfile.mockImplementation(() => {
      throw new Error("Bot が未定義です: missing");
    });
    const interaction = makeInteraction({ bot: "missing" });

    await handleBotCommand(interaction as never);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Bot が未定義です: missing",
      ephemeral: true,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });
});
