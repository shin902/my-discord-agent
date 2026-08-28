import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
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
  it("accepts a valid effective AgentConfig", async () => {
    await expect(
      validateAgentConfig(
        {
          model: { provider: "provider-a", modelId: "model-x" },
          tools: ["read"],
          mounts: [{ host: "groups/main", container: "/repo" }],
        },
        defaultModel,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown effective model", async () => {
    await expect(
      validateAgentConfig(
        { model: { provider: "provider-a", modelId: "missing" } },
        defaultModel,
      ),
    ).rejects.toThrow("不明なモデル");
  });

  it("rejects an unknown effective tool", async () => {
    await expect(
      validateAgentConfig({ tools: ["missing-tool"] }, defaultModel),
    ).rejects.toThrow("不明なツール名");
  });

  it("rejects an invalid effective mount", async () => {
    await expect(
      validateAgentConfig(
        { mounts: [{ host: "../outside", container: "/repo" }] },
        defaultModel,
      ),
    ).rejects.toThrow("リポジトリルート外");
  });
});
