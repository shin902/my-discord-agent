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

const {
  BOT_COMMAND,
  handleBotCommand,
  synchronizeBotCommand,
  synchronizeBotCommandWithRetry,
} = await import("./commands.js");

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
  it("creates /bot without replacing unrelated application commands", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const create = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn();

    await synchronizeBotCommand({
      application: { commands: { fetch, create, set } },
    } as never);

    expect(fetch).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(BOT_COMMAND.toJSON());
    expect(set).not.toHaveBeenCalled();
  });

  it("edits an existing /bot command instead of creating a duplicate", async () => {
    const fetch = vi.fn().mockResolvedValue([
      { id: "bot-command-id", name: "bot", type: 1 },
      { id: "unrelated-id", name: "other", type: 1 },
    ]);
    const edit = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();

    await synchronizeBotCommand({
      application: { commands: { fetch, edit, create } },
    } as never);

    expect(edit).toHaveBeenCalledWith("bot-command-id", BOT_COMMAND.toJSON());
    expect(create).not.toHaveBeenCalled();
  });
});

describe("synchronizeBotCommandWithRetry", () => {
  it("retries transient synchronization failures and eventually succeeds", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue([]);
    const create = vi.fn().mockResolvedValue(undefined);

    await synchronizeBotCommandWithRetry(
      { application: { commands: { fetch, create } } } as never,
      { maxAttempts: 3, retryDelayMs: 0 },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });

  it("stops after the bounded number of attempts", async () => {
    const error = new Error("permanent");
    const fetch = vi.fn().mockRejectedValue(error);

    await expect(
      synchronizeBotCommandWithRetry(
        { application: { commands: { fetch } } } as never,
        { maxAttempts: 3, retryDelayMs: 0 },
      ),
    ).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(3);
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

  it("accepts a command on the default Discord Bot identity", async () => {
    const interaction = makeInteraction({ bot: "coding", prompt: "Fix it" });

    await handleBotCommand(interaction as never, "personal");

    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("accepts a command on the explicitly assigned Discord Bot identity", async () => {
    mocks.findGroupByChannelId.mockResolvedValueOnce({
      group: { name: "main", bot: "secondary" },
      channel: { channelId: "channel-1", sessionMode: "shared" },
    });
    const interaction = makeInteraction({ bot: "coding", prompt: "Fix it" });

    await handleBotCommand(interaction as never, "secondary");

    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("rejects a command received by the wrong Discord Bot identity", async () => {
    const interaction = makeInteraction({ bot: "coding", prompt: "Fix it" });

    await handleBotCommand(interaction as never, "secondary");

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content:
        "このDiscord BotはこのチャンネルのAgentGroupを担当していません。",
      ephemeral: true,
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
