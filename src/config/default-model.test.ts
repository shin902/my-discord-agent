import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  loadRawConfig: vi.fn(),
}));

describe("loadDefaultModel", () => {
  let loadDefaultModel: () => Promise<{ provider: string; modelId: string }>;
  let mockLoadRawConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const configMod = await import("./config.js");
    mockLoadRawConfig = vi.mocked(configMod.loadRawConfig);
    ({ loadDefaultModel } = await import("./default-model.js"));
  });

  it("defaultModel が未設定の場合はエラーになる", async () => {
    mockLoadRawConfig.mockResolvedValue({});
    await expect(loadDefaultModel()).rejects.toThrow("defaultModel");
  });

  it("config.json の defaultModel を優先して返す", async () => {
    mockLoadRawConfig.mockResolvedValue({
      defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4-6" },
    });
    expect(await loadDefaultModel()).toEqual({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
  });

  it("defaultModel が不正な形式の場合はエラーになる", async () => {
    mockLoadRawConfig.mockResolvedValue({ defaultModel: { provider: 1 } });
    await expect(loadDefaultModel()).rejects.toThrow();
  });
});
