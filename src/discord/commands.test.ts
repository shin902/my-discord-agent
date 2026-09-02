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

const { handleBotCommand, handleSkillCommand } = await import(
  "./command-handlers.js"
);
const { command: botCommand } = await import("./commands/bot.js");
const { command: skillCommand } = await import("./commands/skill.js");
const {
  deployDiscordCommands,
  deployDiscordCommandsToBots,
  resolveDiscordCommandDeployTargets,
} = await import("./deploy-commands.js");
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

describe("bot command definition", () => {
  it("defines bot, action, prompt, and session options", () => {
    const json = botCommand.data.toJSON();
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

describe("skill command definition", () => {
  it("defines a required skill and optional prompt without autocomplete", () => {
    const json = skillCommand.data.toJSON();
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
  it("bulk-overwrites the complete registry in a guild scope", async () => {
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
      { body: [botCommand.data.toJSON(), skillCommand.data.toJSON()] },
    );
  });

  it("bulk-overwrites the complete registry in the separate global scope", async () => {
    const put = vi.fn().mockResolvedValue([]);
    await deployDiscordCommands({
      applicationId: "application-1",
      token: "token",
      scope: "global",
      rest: { put } as never,
    });

    expect(put).toHaveBeenCalledWith("/applications/application-1/commands", {
      body: [botCommand.data.toJSON(), skillCommand.data.toJSON()],
    });
  });

  it("requires an explicit deploy scope", async () => {
    await expect(
      deployDiscordCommands({
        applicationId: "application-1",
        token: "token",
      } as never),
    ).rejects.toThrow("usage");
  });

  it("requires a guild id for guild-scope deploys", async () => {
    await expect(
      deployDiscordCommands({
        applicationId: "application-1",
        token: "token",
        scope: "guild",
      }),
    ).rejects.toThrow("guildId");
  });

  it("deploys the same registry to every configured Bot application", async () => {
    const deploy = vi
      .fn()
      .mockResolvedValue([
        botCommand.data.toJSON(),
        skillCommand.data.toJSON(),
      ]);
    const results = await deployDiscordCommandsToBots({
      targets: [
        { botId: "personal", applicationId: "application-1", token: "one" },
        { botId: "public", applicationId: "application-2", token: "two" },
      ],
      scope: "global",
      deploy,
    });

    expect(deploy).toHaveBeenCalledTimes(2);
    expect(deploy).toHaveBeenNthCalledWith(1, {
      applicationId: "application-1",
      token: "one",
      scope: "global",
    });
    expect(deploy).toHaveBeenNthCalledWith(2, {
      applicationId: "application-2",
      token: "two",
      scope: "global",
    });
    expect(results).toEqual([
      {
        botId: "personal",
        applicationId: "application-1",
        status: "succeeded",
        commandCount: 2,
      },
      {
        botId: "public",
        applicationId: "application-2",
        status: "succeeded",
        commandCount: 2,
      },
    ]);
  });

  it("attempts every Bot and reports partial failures without exposing tokens", async () => {
    const deploy = vi
      .fn()
      .mockRejectedValueOnce(new Error("request failed with secret-one"))
      .mockResolvedValueOnce([]);

    await expect(
      deployDiscordCommandsToBots({
        targets: [
          {
            botId: "personal",
            applicationId: "application-1",
            token: "secret-one",
          },
          {
            botId: "public",
            applicationId: "application-2",
            token: "secret-two",
          },
        ],
        scope: "guild",
        guildId: "guild-1",
        deploy,
      }),
    ).rejects.toMatchObject({
      results: [
        expect.objectContaining({
          botId: "personal",
          status: "failed",
          error: "request failed with [REDACTED]",
        }),
        expect.objectContaining({ botId: "public", status: "succeeded" }),
      ],
    });
    expect(deploy).toHaveBeenCalledTimes(2);
  });
});

describe("resolveDiscordCommandDeployTargets", () => {
  it("resolves the implicit default and configured Bot applications", () => {
    expect(
      resolveDiscordCommandDeployTargets(
        {
          bots: {
            public: {
              tokenEnv: "PUBLIC_TOKEN",
              applicationId: "public-application",
            },
          },
        },
        {
          DISCORD_APPLICATION_ID: "default-application",
          DISCORD_BOT_TOKEN: "default-token",
          PUBLIC_TOKEN: "public-token",
        },
      ),
    ).toEqual([
      {
        botId: "personal",
        applicationId: "default-application",
        token: "default-token",
      },
      {
        botId: "public",
        applicationId: "public-application",
        token: "public-token",
      },
    ]);
  });

  it("rejects an additional Bot without an application ID", () => {
    expect(() =>
      resolveDiscordCommandDeployTargets(
        {
          bots: { public: { tokenEnv: "PUBLIC_TOKEN" } },
        },
        {
          DISCORD_APPLICATION_ID: "default-application",
          DISCORD_BOT_TOKEN: "default-token",
          PUBLIC_TOKEN: "public-token",
        },
      ),
    ).toThrow("applicationId");
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
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "スキル名には英数字、ハイフン、アンダースコアのみ使用できます。",
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
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "このコマンドはスレッド内で実行してください。",
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
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
    expect(interaction.editReply).toHaveBeenCalledWith({
      content:
        "このDiscord BotはこのチャンネルのAgentGroupを担当していません。",
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
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.any(String) }),
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
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining("task-one"),
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
    expect(interaction.editReply).toHaveBeenCalledWith({
      content: "Bot が未定義です: missing",
    });
    expect(interaction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
  });
});
