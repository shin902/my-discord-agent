import { beforeEach, describe, expect, it, vi } from "vitest";

const validateAgentConfig = vi.hoisted(() => vi.fn());
vi.mock("./agent-validation.js", () => ({ validateAgentConfig }));
vi.mock("./config.js", () => ({
  loadRawBots: vi.fn(),
  loadRawGroups: vi.fn(),
}));

const { loadRawBots } = await import("./config.js");
const { loadBotRegistry, resolveBotProfile, validateBotConfigs } = await import(
  "./bots.js"
);
const mockLoadRawBots = vi.mocked(loadRawBots);

beforeEach(() => {
  mockLoadRawBots.mockReset();
  validateAgentConfig.mockReset();
  validateAgentConfig.mockResolvedValue(undefined);
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
            instructions: "worker",
            model: { provider: "bot-provider", modelId: "bot-model" },
            tools: ["read"],
          },
        },
        defaultModel,
      ),
    ).resolves.toBeUndefined();
    expect(validateAgentConfig).toHaveBeenCalledWith(
      {
        model: { provider: "bot-provider", modelId: "bot-model" },
        tools: ["read"],
      },
      defaultModel,
    );
  });

  it("rejects a Bot whose group is missing", async () => {
    await expect(
      validateBotConfigs(
        [group],
        { coding: { group: "other", instructions: "worker" } },
        defaultModel,
      ),
    ).rejects.toThrow("Bot coding のグループが未定義です: other");
    expect(validateAgentConfig).not.toHaveBeenCalled();
  });
});

describe("resolveBotProfile", () => {
  const registry = {
    coding: { group: "main", instructions: "coding" },
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
        instructions: "コード変更を担当する worker",
        model: {
          provider: "zai",
          modelId: "glm-4.7-flash",
          thinkingLevel: "high",
        },
        tools: ["read", "write"],
        skills: "*",
        mounts: [{ host: "/repo", container: "/workspace" }],
      },
    });

    await expect(loadBotRegistry()).resolves.toEqual({
      coding: {
        group: "main",
        instructions: "コード変更を担当する worker",
        model: {
          provider: "zai",
          modelId: "glm-4.7-flash",
          thinkingLevel: "high",
        },
        tools: ["read", "write"],
        skills: "*",
        mounts: [{ host: "/repo", container: "/workspace" }],
      },
    });
  });

  it("config.json の bots map ではなく専用ファイルだけを読む", async () => {
    mockLoadRawBots.mockResolvedValue({});

    await expect(loadBotRegistry()).resolves.toEqual({});
    expect(mockLoadRawBots).toHaveBeenCalledOnce();
  });

  it("bot の group は必須", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: { instructions: "コード変更を担当する worker" },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("instructions がない Bot は拒否する", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: { group: "main" },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("instructions が空文字の Bot は拒否する", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: { group: "main", instructions: "" },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("channel 固有の設定を BotProfile に混入させない", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: {
        group: "main",
        instructions: "コード変更を担当する worker",
        channels: [{ channelId: "channel", sessionMode: "shared" }],
        sessionMode: "shared",
      },
    });

    const registry = await loadBotRegistry();
    expect(registry.coding).toEqual({
      group: "main",
      instructions: "コード変更を担当する worker",
    });
    expect(registry.coding).not.toHaveProperty("channels");
    expect(registry.coding).not.toHaveProperty("sessionMode");
  });

  it("AgentConfig の値をそのまま共通 schema で検証する", async () => {
    mockLoadRawBots.mockResolvedValue({
      coding: {
        group: "main",
        instructions: "コード変更を担当する worker",
        mounts: [{ host: "/repo", container: "workspace" }],
      },
    });

    await expect(loadBotRegistry()).rejects.toThrow(
      "mounts.container は絶対パスで指定してください",
    );
  });
});
