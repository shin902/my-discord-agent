import { beforeEach, describe, expect, it, vi } from "vitest";

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
    const { getProviders, getModels } = await import(
      "@earendil-works/pi-ai"
    );
    vi.mocked(getProviders).mockReturnValue(["openai"] as any);
    vi.mocked(getModels).mockReturnValue([
      {
        id: "gpt-4",
        name: "GPT-4",
        api: "openai-chat",
        provider: "openai",
      },
    ] as any);

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
    vi.mocked(getProviders).mockReturnValue([] as any);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "llama-cpp",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
      },
    ] as any);

    const model = await resolveModel("llama-cpp", "llama3");
    expect(model.id).toBe("llama3");
    expect(model.api).toBe("openai-completions");
    expect(model.provider).toBe("llama-cpp");
    expect(model.baseUrl).toBe("http://localhost:8080/v1");
  });

  it("不明なプロバイダはエラー", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as any);
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
    vi.mocked(getProviders).mockReturnValue([] as any);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom",
        baseUrl: "http://{UNSET_HOST}/v1",
      },
    ] as any);

    await expect(resolveModel("custom", "model")).rejects.toThrow(
      "baseUrl に未解決のプレースホルダがあります",
    );
  });

  it("既知のプロバイダーでモデルが見つからない場合はエラー", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders, getModels } = await import(
      "@earendil-works/pi-ai"
    );
    vi.mocked(getProviders).mockReturnValue(["openai"] as any);
    vi.mocked(getModels).mockReturnValue([] as any);

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
