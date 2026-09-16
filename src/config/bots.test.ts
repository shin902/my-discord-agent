import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadRawBots = vi.hoisted(() => vi.fn());
const validateAgentConfig = vi.hoisted(() => vi.fn());
vi.mock("./agent-validation.js", () => ({ validateAgentConfig }));
vi.mock("./config.js", () => ({
  loadRawBots: mockLoadRawBots,
  loadRawGroups: vi.fn(),
}));

type BotsModule = typeof import("./bots.js");
let loadBotRegistry: BotsModule["loadBotRegistry"];
let resolveBotProfile: BotsModule["resolveBotProfile"];
let validateBotConfigs: BotsModule["validateBotConfigs"];
const description = "Implements and reviews code changes.";

beforeEach(async () => {
  vi.resetModules();
  mockLoadRawBots.mockReset();
  validateAgentConfig.mockReset();
  validateAgentConfig.mockResolvedValue(undefined);
  ({ loadBotRegistry, resolveBotProfile, validateBotConfigs } = await import(
    "./bots.js"
  ));
});

describe("validateBotConfigs", () => {
  const group = {
    name: "main",
    channels: [],
    model: { provider: "group-provider", modelId: "group-model" },
  };
  const defaultModel = {
    provider: "default-provider",
    modelId: "default-model",
  };

  it("validates the effective group-to-Bot config", async () => {
    await expect(
      validateBotConfigs(
        [group],
        {
          coding: {
            group: "main",
            description,
            instructions: "worker",
            model: { provider: "bot-provider", modelId: "bot-model" },
            tools: ["read", "get-current-weather"],
            approvalRequiredTools: ["get-current-weather"],
          },
        },
        defaultModel,
      ),
    ).resolves.toBeUndefined();
    expect(validateAgentConfig).toHaveBeenCalledWith(
      {
        model: { provider: "bot-provider", modelId: "bot-model" },
        tools: ["read", "get-current-weather"],
        approvalRequiredTools: ["get-current-weather"],
      },
      defaultModel,
    );
  });

  it("rejects a Bot whose group is missing", async () => {
    await expect(
      validateBotConfigs(
        [group],
        { coding: { group: "other", description, instructions: "worker" } },
        defaultModel,
      ),
    ).rejects.toThrow("Bot coding のグループが未定義です: other");
    expect(validateAgentConfig).not.toHaveBeenCalled();
  });
});

describe("resolveBotProfile", () => {
  const registry = {
    coding: { group: "main", description, instructions: "coding" },
  };

  it("returns a Bot in its configured group", () => {
    expect(resolveBotProfile(registry, "coding", "main")).toEqual(
      registry.coding,
    );
  });

  it("rejects unknown and cross-group Bots", () => {
    expect(() => resolveBotProfile(registry, "missing", "main")).toThrow(
      "Bot が未定義です: missing",
    );
    expect(() => resolveBotProfile(registry, "coding", "other")).toThrow(
      "利用できません",
    );
  });
});

describe("loadBotRegistry", () => {
  it("専用 bots.json の registry map を読み込む", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: {
        group: "main",
        description: `  ${description}  `,
        instructions: "コード変更を担当する worker",
        model: {
          provider: "zai",
          modelId: "glm-4.7-flash",
          thinkingLevel: "high",
        },
        tools: ["read", "write", "get-current-weather"],
        approvalRequiredTools: ["get-current-weather"],
        skills: ["test-skill"],
        mounts: [{ host: "/repo", container: "/workspace" }],
      },
    });

    await expect(loadBotRegistry()).resolves.toEqual({
      coding: {
        group: "main",
        description,
        instructions: "コード変更を担当する worker",
        model: {
          provider: "zai",
          modelId: "glm-4.7-flash",
          thinkingLevel: "high",
        },
        tools: ["read", "write", "get-current-weather"],
        approvalRequiredTools: ["get-current-weather"],
        skills: ["test-skill"],
        mounts: [{ host: "/repo", container: "/workspace" }],
      },
    });
  });

  it("config.json の bots map ではなく専用ファイルだけを読む", async () => {
    mockLoadRawBots.mockResolvedValue({});

    await expect(loadBotRegistry()).resolves.toEqual({});
    expect(mockLoadRawBots).toHaveBeenCalledOnce();
  });

  it("Botなし構成の空Registryを起動後もcacheする", async () => {
    mockLoadRawBots.mockResolvedValueOnce({}).mockResolvedValueOnce({
      coding: { group: "main", description, instructions: "worker" },
    });

    await expect(loadBotRegistry()).resolves.toEqual({});
    await expect(loadBotRegistry()).resolves.toEqual({});
    expect(mockLoadRawBots).toHaveBeenCalledOnce();
  });

  it("bot の group は必須", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: { description, instructions: "コード変更を担当する worker" },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("instructions がない Bot は拒否する", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: { group: "main", description },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("instructions が空文字の Bot は拒否する", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: { group: "main", description, instructions: "" },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it.each([
    undefined,
    "",
    " \n\t ",
    123,
  ])("descriptionが未指定・空白・非文字列のBotを拒否する: %j", async (description) => {
    mockLoadRawBots.mockResolvedValue({
      coding: { group: "main", instructions: "worker", description },
    });

    await expect(loadBotRegistry()).rejects.toThrow("description");
  });

  it("channel 固有の設定を BotProfile に混入させない", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: {
        group: "main",
        description,
        instructions: "コード変更を担当する worker",
        channels: [{ channelId: "channel", sessionMode: "shared" }],
        sessionMode: "shared",
      },
    });

    const registry = await loadBotRegistry();
    expect(registry.coding).toEqual({
      group: "main",
      description,
      instructions: "コード変更を担当する worker",
    });
    expect(registry.coding).not.toHaveProperty("channels");
    expect(registry.coding).not.toHaveProperty("sessionMode");
  });

  it("AgentConfig の値をそのまま共通 schema で検証する", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: {
        group: "main",
        description,
        instructions: "コード変更を担当する worker",
        mounts: [{ host: "/repo", container: "workspace" }],
      },
    });

    await expect(loadBotRegistry()).rejects.toThrow(
      "mounts.container は絶対パスで指定してください",
    );
  });
});
