import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGroupByChannelId: vi.fn(),
  loadBotRegistry: vi.fn(),
  resolveBotProfile: vi.fn(),
  enqueue: vi.fn(),
  createBotTaskSession: vi.fn(),
  findBotTaskSession: vi.fn(),
  listBotTaskSessions: vi.fn(),
  touchBotTaskSession: vi.fn(),
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
  getQueueRepository: () => ({
    enqueue: mocks.enqueue,
    createBotTaskSession: mocks.createBotTaskSession,
    findBotTaskSession: mocks.findBotTaskSession,
    listBotTaskSessions: mocks.listBotTaskSessions,
    touchBotTaskSession: mocks.touchBotTaskSession,
  }),
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
  action?: string;
  session?: string;
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
      getString: (name: string) => {
        if (name === "bot") return options.bot ?? "coding";
        if (name === "action") return options.action;
        if (name === "session") return options.session;
        return options.prompt ?? "Do it";
      },
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
  mocks.createBotTaskSession.mockImplementation((input) => ({
    sessionId: input.sessionId,
    handle: input.handle,
    groupName: input.groupName,
    botId: input.botId,
    channelId: input.channelId,
    createdAt: input.createdAt,
    lastUsedAt: input.createdAt,
    preview: input.preview,
  }));
  mocks.findBotTaskSession.mockReturnValue(undefined);
  mocks.listBotTaskSessions.mockReturnValue([]);
  mocks.touchBotTaskSession.mockReturnValue(undefined);
});

describe("BOT_COMMAND", () => {
  it("defines bot, action, prompt, and session options", () => {
    const json = BOT_COMMAND.toJSON();
    expect(json.name).toBe("bot");
    expect(json.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bot", type: 3, required: true }),
        expect.objectContaining({ name: "action", type: 3 }),
        expect.objectContaining({ name: "prompt", type: 3, required: false }),
        expect.objectContaining({ name: "session", type: 3, required: false }),
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
      sessionId: expect.stringMatching(/^bot-task-/),
      content: "Fix it",
      timestamp: expect.any(String),
      idempotencyKey: "discord-interaction:interaction-1",
      botId: "coding",
    });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringMatching(
        /^Botへの依頼を受け付けました。Task Session: task-/,
      ),
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
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
        sessionId: expect.stringMatching(/^bot-task-/),
      }),
    );
  });

  it("creates a fresh task session and keeps delivery on the invoking thread", async () => {
    const interaction = makeInteraction({
      action: "run",
      bot: "coding",
      prompt: "Investigate this issue",
      channelId: "thread-1",
      isThread: true,
      parentId: "channel-1",
    });

    await handleBotCommand(interaction as never);

    expect(mocks.createBotTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({
        groupName: "main",
        botId: "coding",
        channelId: "thread-1",
        preview: "Investigate this issue",
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "thread-1",
        sessionId: expect.stringMatching(/^bot-task-/),
      }),
    );
  });

  it("resumes only the explicitly owned task session", async () => {
    mocks.findBotTaskSession.mockReturnValue({
      sessionId: "bot-task-existing",
      handle: "task-existing",
      groupName: "main",
      botId: "coding",
      channelId: "old-channel",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      preview: "Existing task",
    });
    const interaction = makeInteraction({
      action: "resume",
      session: "task-existing",
      prompt: "Continue it",
    });

    await handleBotCommand(interaction as never);

    expect(mocks.findBotTaskSession).toHaveBeenCalledWith(
      "task-existing",
      "main",
      "coding",
    );
    expect(mocks.touchBotTaskSession).toHaveBeenCalledWith(
      "bot-task-existing",
      "channel-1",
      expect.any(String),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "bot-task-existing",
        channelId: "channel-1",
        botId: "coding",
      }),
    );
  });

  it.each([
    { label: "unknown", session: "task-missing" },
    { label: "unsafe", session: "../secrets" },
  ])("rejects $label resume handles without enqueueing", async ({
    session,
  }) => {
    const interaction = makeInteraction({
      action: "resume",
      session,
      prompt: "Continue it",
    });

    await handleBotCommand(interaction as never);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    if (session.includes("/")) {
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.any(String),
          ephemeral: true,
        }),
      );
    } else {
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.any(String) }),
      );
    }
  });

  it("lists only sessions owned by the selected group and Bot", async () => {
    mocks.listBotTaskSessions.mockReturnValue([
      {
        sessionId: "bot-task-1",
        handle: "task-one",
        groupName: "main",
        botId: "coding",
        channelId: "channel-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-02T00:00:00.000Z",
        preview: "Fix the parser",
      },
    ]);
    const interaction = makeInteraction({
      action: "list",
      bot: "coding",
      prompt: "",
    });

    await handleBotCommand(interaction as never);

    expect(mocks.listBotTaskSessions).toHaveBeenCalledWith("main", "coding");
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining("task-one"),
      ephemeral: true,
    });
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
