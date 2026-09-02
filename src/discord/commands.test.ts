import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findGroupByChannelId: vi.fn(),
  loadBotRegistry: vi.fn(),
  resolveBotProfile: vi.fn(),
  createBotTaskSessionAndEnqueue: vi.fn(),
  resumeBotTaskSessionAndEnqueue: vi.fn(),
  listBotTaskSessions: vi.fn(),
  enqueue: vi.fn(),
  loadMemoryConfig: vi.fn(),
}));

vi.mock("../config/groups.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/groups.js")>();
  return { ...actual, findGroupByChannelId: mocks.findGroupByChannelId };
});
vi.mock("../config/bots.js", () => ({
  loadBotRegistry: mocks.loadBotRegistry,
  resolveBotProfile: mocks.resolveBotProfile,
}));
vi.mock("../config/agent-memory.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../config/agent-memory.js")>();
  return { ...actual, loadAgentMemoryConfig: mocks.loadMemoryConfig };
});
vi.mock("../queue/repository.js", () => ({
  getQueueRepository: () => ({
    createBotTaskSessionAndEnqueue: mocks.createBotTaskSessionAndEnqueue,
    resumeBotTaskSessionAndEnqueue: mocks.resumeBotTaskSessionAndEnqueue,
    listBotTaskSessions: mocks.listBotTaskSessions,
    enqueue: mocks.enqueue,
  }),
}));

const {
  BOT_COMMAND,
  SKILL_COMMAND,
  handleBotCommand,
  handleSkillCommand,
  synchronizeDiscordCommands,
  synchronizeDiscordCommandsWithRetry,
} = await import("./commands.js");
const { deployDiscordCommands } = await import("./deploy-commands.js");
const { DISCORD_COMMANDS, getDiscordCommand } = await import(
  "./command-registry.js"
);

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

function makeSkillInteraction(options: {
  skill?: string;
  prompt?: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string | null;
  userId?: string;
  userIsBot?: boolean;
}) {
  return {
    id: "skill-interaction-1",
    channelId: options.channelId ?? "channel-1",
    user: {
      id: options.userId ?? "user-1",
      bot: options.userIsBot ?? false,
    },
    channel: {
      isThread: () => options.isThread ?? false,
      parentId: options.parentId ?? null,
    },
    options: {
      getString: (name: string) =>
        name === "skill" ? (options.skill ?? "session-logs") : options.prompt,
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
  mocks.createBotTaskSessionAndEnqueue.mockImplementation((input) => ({
    session: {
      sessionId: input.sessionId,
      handle: input.handle,
      groupName: input.groupName,
      botId: input.botId,
      channelId: input.channelId,
      createdAt: input.createdAt,
      lastUsedAt: input.createdAt,
      preview: input.preview,
    },
    enqueue: { job: {}, inserted: true },
  }));
  mocks.resumeBotTaskSessionAndEnqueue.mockReturnValue(undefined);
  mocks.listBotTaskSessions.mockReturnValue([]);
  mocks.loadMemoryConfig.mockResolvedValue({
    enabled: false,
    baseUrl: "http://127.0.0.1:8420",
    serviceId: "default",
    teamId: "team",
    agentId: "agent",
    eligibleGroups: [],
    timeoutMs: 1000,
  });
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

describe("SKILL_COMMAND", () => {
  it("defines a required skill and optional prompt without autocomplete", () => {
    const json = SKILL_COMMAND.toJSON();
    expect(json.name).toBe("skill");
    expect(json.options).toEqual([
      expect.objectContaining({
        name: "skill",
        type: 3,
        required: true,
        autocomplete: undefined,
      }),
      expect.objectContaining({
        name: "prompt",
        type: 3,
        required: false,
      }),
    ]);
  });
});

describe("synchronizeDiscordCommands", () => {
  it("creates /bot and /skill without replacing unrelated commands", async () => {
    const fetch = vi.fn().mockResolvedValue([]);
    const create = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn();

    await synchronizeDiscordCommands({
      application: { commands: { fetch, create, set } },
    } as never);

    expect(fetch).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(BOT_COMMAND.toJSON());
    expect(create).toHaveBeenCalledWith(SKILL_COMMAND.toJSON());
    expect(set).not.toHaveBeenCalled();
  });

  it("edits existing owned commands instead of creating duplicates", async () => {
    const fetch = vi.fn().mockResolvedValue([
      { id: "bot-command-id", name: "bot", type: 1 },
      { id: "skill-command-id", name: "skill", type: 1 },
      { id: "unrelated-id", name: "other", type: 1 },
    ]);
    const edit = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn();

    await synchronizeDiscordCommands({
      application: { commands: { fetch, edit, create } },
    } as never);

    expect(edit).toHaveBeenCalledWith("bot-command-id", BOT_COMMAND.toJSON());
    expect(edit).toHaveBeenCalledWith(
      "skill-command-id",
      SKILL_COMMAND.toJSON(),
    );
    expect(create).not.toHaveBeenCalled();
  });
});

describe("command registry", () => {
  it("discovers each command module by its chat-input name", () => {
    expect(DISCORD_COMMANDS.map(({ data }) => data.toJSON().name)).toEqual([
      "bot",
      "skill",
    ]);
    expect(getDiscordCommand("bot")?.execute).toEqual(expect.any(Function));
    expect(getDiscordCommand("missing")).toBeUndefined();
  });
});

describe("deployDiscordCommands", () => {
  it("deploys the registry to a guild without starting the runtime", async () => {
    const put = vi.fn().mockResolvedValue([]);
    await deployDiscordCommands({
      applicationId: "application-1",
      token: "token",
      scope: "guild",
      guildId: "guild-1",
      rest: { put } as never,
    });

    expect(put).toHaveBeenCalledWith(
      "/applications/application-1/guilds/guild-1/commands",
      { body: [BOT_COMMAND.toJSON(), SKILL_COMMAND.toJSON()] },
    );
  });

  it("deploys global commands through the application route", async () => {
    const put = vi.fn().mockResolvedValue([]);
    await deployDiscordCommands({
      applicationId: "application-1",
      token: "token",
      rest: { put } as never,
    });

    expect(put).toHaveBeenCalledWith("/applications/application-1/commands", {
      body: [BOT_COMMAND.toJSON(), SKILL_COMMAND.toJSON()],
    });
  });

  it("requires a guild id for guild deploys", async () => {
    await expect(
      deployDiscordCommands({
        applicationId: "application-1",
        token: "token",
        scope: "guild",
      }),
    ).rejects.toThrow("guildId");
  });
});

describe("synchronizeDiscordCommandsWithRetry", () => {
  it("retries transient synchronization failures and eventually succeeds", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue([]);
    const create = vi.fn().mockResolvedValue(undefined);

    await synchronizeDiscordCommandsWithRetry(
      { application: { commands: { fetch, create } } } as never,
      { maxAttempts: 3, retryDelayMs: 0 },
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("stops after the bounded number of attempts", async () => {
    const error = new Error("permanent");
    const fetch = vi.fn().mockRejectedValue(error);

    await expect(
      synchronizeDiscordCommandsWithRetry(
        { application: { commands: { fetch } } } as never,
        { maxAttempts: 3, retryDelayMs: 0 },
      ),
    ).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("handleSkillCommand", () => {
  it("enqueues the existing ./command form in a shared session", async () => {
    const interaction = makeSkillInteraction({
      skill: "session-logs",
      prompt: "昨日の作業を探して",
    });

    await handleSkillCommand(interaction as never);

    expect(mocks.enqueue).toHaveBeenCalledWith({
      channelId: "channel-1",
      groupName: "main",
      routingChannelId: "channel-1",
      sessionId: "channel-1",
      content: "./command session-logs 昨日の作業を探して",
      timestamp: expect.any(String),
      idempotencyKey: "discord-interaction:skill-interaction-1",
      configOverride: {
        model: { provider: "channel-provider", modelId: "channel-model" },
      },
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "スキル「session-logs」の実行を受け付けました。",
    });
  });

  it("persists the invoking user for an eligible Agent Memory turn", async () => {
    mocks.loadMemoryConfig.mockResolvedValueOnce({
      enabled: true,
      baseUrl: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "team",
      agentId: "agent",
      eligibleGroups: ["main"],
      timeoutMs: 1000,
    });
    const interaction = makeSkillInteraction({ userId: "eligible-user" });

    await handleSkillCommand(interaction as never);

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "eligible-user" }),
    );
  });

  it("does not persist the invoking user for an ineligible Agent Memory turn", async () => {
    mocks.loadMemoryConfig.mockResolvedValueOnce({
      enabled: true,
      baseUrl: "http://127.0.0.1:8420",
      serviceId: "default",
      teamId: "team",
      agentId: "agent",
      eligibleGroups: ["other-group"],
      timeoutMs: 1000,
    });
    const interaction = makeSkillInteraction({ userId: "ineligible-user" });

    await handleSkillCommand(interaction as never);

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.not.objectContaining({ userId: expect.anything() }),
    );
  });

  it("still enqueues when Agent Memory config loading fails", async () => {
    mocks.loadMemoryConfig.mockRejectedValueOnce(new Error("config failed"));
    const interaction = makeSkillInteraction({ userId: "user-config-failed" });

    await handleSkillCommand(interaction as never);

    expect(mocks.enqueue).toHaveBeenCalledOnce();
    expect(mocks.enqueue.mock.calls[0]?.[0]).not.toHaveProperty("userId");
  });

  it("resolves a thread through its parent and keeps the thread session", async () => {
    mocks.findGroupByChannelId.mockResolvedValueOnce({
      group: { name: "main" },
      channel: { channelId: "parent-channel", sessionMode: "thread" },
    });
    const interaction = makeSkillInteraction({
      skill: "agent-reach",
      channelId: "thread-1",
      isThread: true,
      parentId: "parent-channel",
    });

    await handleSkillCommand(interaction as never);

    expect(mocks.findGroupByChannelId).toHaveBeenCalledWith("parent-channel");
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "thread-1",
        routingChannelId: "parent-channel",
        sessionId: "thread-1",
        content: "./command agent-reach",
      }),
    );
  });

  it("rejects invalid skill names before enqueueing", async () => {
    const interaction = makeSkillInteraction({ skill: "../secret" });

    await handleSkillCommand(interaction as never);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "スキル名には英数字、ハイフン、アンダースコアのみ使用できます。",
      ephemeral: true,
    });
  });

  it("rejects parent-channel execution for thread-based sessions", async () => {
    mocks.findGroupByChannelId.mockResolvedValueOnce({
      group: { name: "main" },
      channel: { channelId: "channel-1", sessionMode: "auto-thread" },
    });
    const interaction = makeSkillInteraction({ skill: "session-logs" });

    await handleSkillCommand(interaction as never);

    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "このコマンドはスレッド内で実行してください。",
      ephemeral: true,
    });
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
    expect(mocks.createBotTaskSessionAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        groupName: "main",
        botId: "coding",
        sourceKey: "discord-interaction:interaction-1",
      }),
      expect.objectContaining({
        channelId: "channel-1",
        content: "Fix it",
        idempotencyKey: "discord-interaction:interaction-1",
        botId: "coding",
      }),
    );
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

    expect(mocks.createBotTaskSessionAndEnqueue).toHaveBeenCalledOnce();
  });

  it("accepts a command on the explicitly assigned Discord Bot identity", async () => {
    mocks.findGroupByChannelId.mockResolvedValueOnce({
      group: { name: "main", bot: "secondary" },
      channel: { channelId: "channel-1", sessionMode: "shared" },
    });
    const interaction = makeInteraction({ bot: "coding", prompt: "Fix it" });

    await handleBotCommand(interaction as never, "secondary");

    expect(mocks.createBotTaskSessionAndEnqueue).toHaveBeenCalledOnce();
  });

  it("rejects a command received by the wrong Discord Bot identity", async () => {
    const interaction = makeInteraction({ bot: "coding", prompt: "Fix it" });

    await handleBotCommand(interaction as never, "secondary");

    expect(mocks.createBotTaskSessionAndEnqueue).not.toHaveBeenCalled();
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
    expect(mocks.createBotTaskSessionAndEnqueue).toHaveBeenCalledWith(
      expect.not.objectContaining({ channelId: "channel-1" }),
      expect.objectContaining({ channelId: "channel-1" }),
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

    expect(mocks.createBotTaskSessionAndEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        groupName: "main",
        botId: "coding",
        preview: "Investigate this issue",
      }),
      expect.objectContaining({ channelId: "thread-1" }),
    );
  });

  it("resumes only the explicitly owned task session", async () => {
    mocks.resumeBotTaskSessionAndEnqueue.mockReturnValue({
      session: {
        sessionId: "bot-task-existing",
        handle: "task-existing",
        groupName: "main",
        botId: "coding",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-02T00:00:00.000Z",
        preview: "Existing task",
      },
      enqueue: { job: {}, inserted: true },
    });
    const interaction = makeInteraction({
      action: "resume",
      session: "task-existing",
      prompt: "Continue it",
    });

    await handleBotCommand(interaction as never);

    expect(mocks.resumeBotTaskSessionAndEnqueue).toHaveBeenCalledWith(
      "task-existing",
      "main",
      "coding",
      expect.any(String),
      expect.objectContaining({
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

    if (session.includes("/")) {
      expect(mocks.resumeBotTaskSessionAndEnqueue).not.toHaveBeenCalled();
      expect(interaction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.any(String),
          ephemeral: true,
        }),
      );
    } else {
      expect(mocks.resumeBotTaskSessionAndEnqueue).toHaveBeenCalledWith(
        "task-missing",
        "main",
        "coding",
        expect.any(String),
        expect.objectContaining({ idempotencyKey: expect.any(String) }),
      );
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
    expect(mocks.createBotTaskSessionAndEnqueue).not.toHaveBeenCalled();
    expect(mocks.resumeBotTaskSessionAndEnqueue).not.toHaveBeenCalled();
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

    expect(mocks.createBotTaskSessionAndEnqueue).not.toHaveBeenCalled();
    expect(mocks.resumeBotTaskSessionAndEnqueue).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Bot が未定義です: missing",
      ephemeral: true,
    });
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });
});
