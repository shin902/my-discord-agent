import type { KnownProvider, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CredentialEntry } from "../config/credential-proxy.js";

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: vi.fn(),
  getModels: vi.fn(),
}));

vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn(),
}));

async function importFresh() {
  vi.resetModules();
  const mod = await import("./model.js");
  return mod as typeof import("./model.js");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveModel", () => {
  it("既知のプロバイダーのモデルを解決する", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders, getModels } = await import("@earendil-works/pi-ai");
    vi.mocked(getProviders).mockReturnValue(["openai"] as KnownProvider[]);
    vi.mocked(getModels).mockReturnValue([
      {
        id: "gpt-4",
        name: "GPT-4",
        api: "openai-chat",
        provider: "openai",
      },
    ] as unknown as Model<never>[]);

    const model = await resolveModel("openai", "gpt-4");
    expect(model.id).toBe("gpt-4");
    expect(model.provider).toBe("openai");
  });

  it("credential-proxy に定義されたカスタムプロバイダを解決する", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "llama-cpp",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("llama-cpp", "llama3");
    expect(model.id).toBe("llama3");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("llama-cpp");
    expect(model.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("compat.thinkingFormat があるカスタムプロバイダは reasoning を自動で有効にする", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom-qwen",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("custom-qwen", "qwen3");
    expect(model.reasoning).toBe(true);
    expect(model.compat).toEqual({ thinkingFormat: "qwen-chat-template" });
  });

  it("llama-cpp の qwen 互換設定は chat_template_kwargs 形式に補正する", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "llama-cpp",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        compat: { thinkingFormat: "qwen" },
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("llama-cpp", "qwen3");
    expect(model.compat).toEqual({ thinkingFormat: "qwen-chat-template" });
  });

  it("Ollama の qwen 互換設定は reasoning.effort 形式に補正する", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "ollama",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        compat: { thinkingFormat: "qwen" },
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("ollama", "qwen3");
    expect(model.compat).toEqual({ thinkingFormat: "openrouter" });
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      xhigh: "high",
    });
  });

  it("不明なプロバイダはエラー", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([]);

    await expect(resolveModel("unknown", "model")).rejects.toThrow(
      "不明なプロバイダ: unknown",
    );
  });

  it("baseUrl に未解決のプレースホルダがある場合はエラー", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom",
        baseUrl: "http://{UNSET_HOST}/v1",
      },
    ] as CredentialEntry[]);

    await expect(resolveModel("custom", "model")).rejects.toThrow(
      "baseUrl に未解決のプレースホルダがあります",
    );
  });

  it("既知のプロバイダーでモデルが見つからない場合はエラー", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders, getModels } = await import("@earendil-works/pi-ai");
    vi.mocked(getProviders).mockReturnValue(["openai"] as KnownProvider[]);
    vi.mocked(getModels).mockReturnValue([]);

    await expect(resolveModel("openai", "unknown-model")).rejects.toThrow(
      "不明なモデル: unknown-model (provider: openai)",
    );
  });
});

describe("resolveBaseUrl", () => {
  it("環境変数プレースホルダを解決する", async () => {
    const { resolveBaseUrl } = await importFresh();
    process.env.TEST_HOST = "localhost";
    expect(resolveBaseUrl("http://{TEST_HOST}:8080")).toBe(
      "http://localhost:8080",
    );
    delete process.env.TEST_HOST;
  });

  it("未解決のプレースホルダがある場合は null を返す", async () => {
    const { resolveBaseUrl } = await importFresh();
    expect(resolveBaseUrl("http://{UNSET}/v1")).toBeNull();
  });

  it("プレースホルダがない場合はそのまま返す", async () => {
    const { resolveBaseUrl } = await importFresh();
    expect(resolveBaseUrl("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
  });
});
