import { beforeEach, describe, expect, it, vi } from "vitest";

const validateAgentConfig = vi.hoisted(() => vi.fn());
vi.mock("./agent-validation.js", () => ({ validateAgentConfig }));
vi.mock("./config.js", () => ({
  loadRawConfig: vi.fn(),
  loadRawGroups: vi.fn(),
}));

const { loadRawConfig } = await import("./config.js");
const { loadBotRegistry, resolveBotProfile, validateBotConfigs } = await import(
  "./bots.js"
);
const mockLoadRawConfig = vi.mocked(loadRawConfig);

beforeEach(() => {
  mockLoadRawConfig.mockReset();
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
  it("config.json のトップレベル bots map を読み込む", async () => {
    mockLoadRawConfig.mockResolvedValue({
      bots: {
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

  it("bots を省略した場合は空の registry を返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ defaultModel: {} });

    await expect(loadBotRegistry()).resolves.toEqual({});
  });

  it("bot の group は必須", async () => {
    mockLoadRawConfig.mockResolvedValue({
      bots: { coding: { instructions: "コード変更を担当する worker" } },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("instructions がない Bot は拒否する", async () => {
    mockLoadRawConfig.mockResolvedValue({
      bots: { coding: { group: "main" } },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("instructions が空文字の Bot は拒否する", async () => {
    mockLoadRawConfig.mockResolvedValue({
      bots: { coding: { group: "main", instructions: "" } },
    });

    await expect(loadBotRegistry()).rejects.toThrow();
  });

  it("channel 固有の設定を BotProfile に混入させない", async () => {
    mockLoadRawConfig.mockResolvedValue({
      bots: {
        coding: {
          group: "main",
          instructions: "コード変更を担当する worker",
          channels: [{ channelId: "channel", sessionMode: "shared" }],
          sessionMode: "shared",
        },
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
    mockLoadRawConfig.mockResolvedValue({
      bots: {
        coding: {
          group: "main",
          instructions: "コード変更を担当する worker",
          mounts: [{ host: "/repo", container: "workspace" }],
        },
      },
    });

    await expect(loadBotRegistry()).rejects.toThrow(
      "mounts.container は絶対パスで指定してください",
    );
  });
});
