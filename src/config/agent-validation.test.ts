import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat", () => ({
  getProviders: () => ["provider-a", "zai"],
  getModels: (provider: string) =>
    provider === "zai"
      ? [{ id: "glm-4.7-flash", name: "GLM-4.7-Flash" }]
      : [{ id: "model-x", name: "Model X" }],
}));

const loadCredentialProxy = vi.hoisted(() => vi.fn());
vi.mock("./credential-proxy.js", () => ({ loadCredentialProxy }));

const { validateAgentConfig } = await import("./agent-validation.js");

const defaultModel = { provider: "zai", modelId: "glm-4.7-flash" };

beforeEach(() => {
  loadCredentialProxy.mockResolvedValue([]);
});

describe("validateAgentConfig", () => {
  it.each([
    "get-current-weather",
    "codex-cloud-submit",
  ])("accepts a valid effective AgentConfig with approval for %s", async (tool) => {
    await expect(
      validateAgentConfig(
        {
          model: { provider: "provider-a", modelId: "model-x" },
          tools: [tool],
          approvalRequiredTools: [tool],
          mounts: [{ host: "groups/main", container: "/repo" }],
        },
        defaultModel,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown effective model", async () => {
    await expect(
      validateAgentConfig(
        {
          model: { provider: "provider-a", modelId: "missing" },
          tools: [],
        },
        defaultModel,
      ),
    ).rejects.toThrow("不明なモデル");
  });

  it("accepts context-created tools as recognized tools", async () => {
    await expect(
      validateAgentConfig({ tools: ["bot", "subagent"] }, defaultModel),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown effective tool", async () => {
    await expect(
      validateAgentConfig({ tools: ["missing-tool"] }, defaultModel),
    ).rejects.toThrow("不明なツール名");
  });

  it("accepts omitted and empty approvalRequiredTools without approval", async () => {
    await expect(
      validateAgentConfig({ tools: ["read"] }, defaultModel),
    ).resolves.toBeUndefined();
    await expect(
      validateAgentConfig(
        { tools: ["read"], approvalRequiredTools: [] },
        defaultModel,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown approval-required tool", async () => {
    await expect(
      validateAgentConfig(
        {
          tools: ["get-current-weather"],
          approvalRequiredTools: ["missing-tool"],
        },
        defaultModel,
      ),
    ).rejects.toThrow("不明なツール名: missing-tool");
  });

  it("accepts an approval-required capability provided by a trusted toolSet", async () => {
    await expect(
      validateAgentConfig(
        {
          tools: ["bash"],
          toolSets: ["weather"],
          approvalRequiredTools: ["get-current-weather"],
        },
        defaultModel,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an approval-required tool outside effective tools and toolSets even when a Skill is selected", async () => {
    await expect(
      validateAgentConfig(
        {
          tools: ["read"],
          skills: ["weather"],
          approvalRequiredTools: ["get-current-weather"],
        },
        defaultModel,
      ),
    ).rejects.toThrow(
      "承認必須ツールは有効な tools または toolSets に含めてください: get-current-weather",
    );
  });

  it.each(["*", "unknown"])("rejects toolSet %s at startup", async (name) => {
    await expect(
      validateAgentConfig({ tools: [], toolSets: [name] }, defaultModel),
    ).rejects.toThrow(`Unknown toolSet: ${name}`);
  });

  it("rejects a sandbox approval-required tool", async () => {
    await expect(
      validateAgentConfig(
        { tools: ["read"], approvalRequiredTools: ["read"] },
        defaultModel,
      ),
    ).rejects.toThrow(
      "承認必須ツールには host/runtime capability のみ指定できます: read",
    );
  });

  it("rejects an invalid effective mount", async () => {
    await expect(
      validateAgentConfig(
        {
          tools: [],
          mounts: [{ host: "../outside", container: "/repo" }],
        },
        defaultModel,
      ),
    ).rejects.toThrow("リポジトリルート外");
  });
});

describe("channel Bot validation at startup", () => {
  const bots = {
    research: {
      group: "group",
      description: "Research",
      instructions: "Research role",
      tools: ["get-current-weather"],
      approvalRequiredTools: ["get-current-weather"],
    },
  };
  it.each([
    "missing",
    "research",
  ])("rejects invalid assignment %s", async (botId) => {
    const { validateGroupConfig } = await import("../agent/manager.js");
    await expect(
      validateGroupConfig(
        {
          name: "other",
          channels: [{ channelId: "parent", sessionMode: "thread", botId }],
        },
        defaultModel,
        bots,
      ),
    ).rejects.toThrow(botId === "missing" ? "未定義" : "利用できません");
  });
  it("validates the final group → Bot → channel config", async () => {
    const { validateGroupConfig } = await import("../agent/manager.js");
    const channel = {
      channelId: "parent",
      sessionMode: "shared" as const,
      botId: "research",
      tools: ["read"],
    };
    await expect(
      validateGroupConfig(
        { name: "group", channels: [channel] },
        defaultModel,
        bots,
      ),
    ).rejects.toThrow("承認必須ツール");
    await expect(
      validateGroupConfig(
        {
          name: "group",
          channels: [{ ...channel, approvalRequiredTools: [] }],
        },
        defaultModel,
        bots,
      ),
    ).resolves.toBeUndefined();
  });
});
