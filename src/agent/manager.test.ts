import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: () => ["provider-a", "opencode-go"],
  getModels: (provider: string) =>
    provider === "opencode-go"
      ? [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
      : [{ id: "model-x", name: "Model X" }],
}));

const { resolveModel } = await import("./manager.js");

describe("resolveModel", () => {
  it("有効なプロバイダとモデルIDはモデルを返す", () => {
    const model = resolveModel("provider-a", "model-x");
    expect(model.id).toBe("model-x");
  });

  it("不明なプロバイダはエラー", () => {
    expect(() => resolveModel("unknown-provider", "model-x")).toThrow(
      "不明なプロバイダ: unknown-provider",
    );
  });

  it("不明なモデルIDはエラー", () => {
    expect(() => resolveModel("provider-a", "unknown-model")).toThrow(
      "不明なモデル: unknown-model (provider: provider-a)",
    );
  });
});

describe("sendMessage: 設定バリデーション", () => {
  it("不正なツール名を持つグループ設定は設定エラーを返す", async () => {
    vi.resetModules();
    vi.doMock("microsandbox", () => ({ Sandbox: { builder: vi.fn() } }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({ tools: ["invalid"] }),
      loadGroupSystemPrompt: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([]),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("設定エラー: 不明なツール名: invalid");
  });

  it("不正なプロバイダを持つグループ設定は設定エラーを返す", async () => {
    vi.resetModules();
    vi.doMock("microsandbox", () => ({ Sandbox: { builder: vi.fn() } }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi
        .fn()
        .mockResolvedValue({ model: { provider: "unknown", modelId: "x" } }),
      loadGroupSystemPrompt: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([]),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("設定エラー: 不明なプロバイダ: unknown");
  });
});
