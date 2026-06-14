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
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(loadCredentialProxy).mockResolvedValue([]);
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
    expect(model.input).toEqual(["text"]);
  });

  it("models[modelId].input で modelId 単位に入力モダリティを指定できる", async () => {
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
        models: {
          "qwen-vl": { input: ["text", "image"] },
        },
      },
    ] as CredentialEntry[]);

    const visionModel = await resolveModel("llama-cpp", "qwen-vl");
    expect(visionModel.input).toEqual(["text", "image"]);

    const textModel = await resolveModel("llama-cpp", "qwen-coder");
    expect(textModel.input).toEqual(["text"]);
  });

  it("forceCustom: true の場合、KnownProvider と衝突していてもカスタムプロバイダーとして解決する", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue(["groq"] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "groq",
        forceCustom: true,
        baseUrl: "https://api.groq.com/openai/v1",
        api: "openai-completions",
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("groq", "llama-3.3-70b-versatile");
    expect(model.provider).toBe("groq");
    expect(model.baseUrl).toBe("https://api.groq.com/openai/v1");
    expect(model.id).toBe("llama-3.3-70b-versatile");
  });

  it("forceCustom が未指定の場合は KnownProvider 側のモデル一覧から解決する（回帰確認）", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders, getModels } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue(["groq"] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "groq",
        baseUrl: "https://api.groq.com/openai/v1",
      },
    ] as CredentialEntry[]);
    vi.mocked(getModels).mockReturnValue([
      {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B",
        api: "openai-chat",
        provider: "groq",
      },
    ] as unknown as Model<never>[]);

    const model = await resolveModel("groq", "llama-3.3-70b-versatile");
    expect(model.id).toBe("llama-3.3-70b-versatile");
    expect(model.provider).toBe("groq");
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

  it("qwen: llama-cpp でも ollama でもないプロバイダ（vLLM 等）は 'qwen' のまま返す（pi-ai が enable_thinking で処理するため安全）", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom-unknown",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        compat: { thinkingFormat: "qwen" },
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("custom-unknown", "qwen3");
    expect(model.compat).toEqual({ thinkingFormat: "qwen" });
    expect(
      (model as { thinkingLevelMap?: unknown }).thinkingLevelMap,
    ).toBeUndefined();
  });

  it("thinkingFormat: 'openrouter' を明示した場合は thinkingLevelMap が付かない", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "my-openrouter",
        baseUrl: "http://openrouter.ai/v1",
        api: "openai-completions",
        compat: { thinkingFormat: "openrouter" },
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("my-openrouter", "deepseek-r1");
    expect(model.compat).toEqual({ thinkingFormat: "openrouter" });
    expect(model.reasoning).toBe(true);
    expect(
      (model as { thinkingLevelMap?: unknown }).thinkingLevelMap,
    ).toBeUndefined();
  });

  it("reasoning: true を明示した場合は compat がなくても上書きされない", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom-reasoning",
        baseUrl: "http://localhost:9090/v1",
        api: "openai-completions",
        reasoning: true,
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("custom-reasoning", "some-model");
    expect(model.reasoning).toBe(true);
    expect(model.compat).toBeUndefined();
  });

  it("reasoning: false を明示した場合は thinkingFormat があっても上書きされない", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom-no-reasoning",
        baseUrl: "http://localhost:9090/v1",
        api: "openai-completions",
        reasoning: false,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("custom-no-reasoning", "some-model");
    expect(model.reasoning).toBe(false);
    expect(model.compat).toBeUndefined();
  });

  it("ポート 11434 のみで Ollama を検出し thinkingLevelMap を付与する", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom",
        baseUrl: "http://custom-host:11434/v1",
        api: "openai-completions",
        compat: { thinkingFormat: "qwen" },
      },
    ] as CredentialEntry[]);

    const model = await resolveModel("custom", "qwen3");
    expect(model.compat).toEqual({ thinkingFormat: "openrouter" });
    expect(model.thinkingLevelMap).toEqual({
      off: "none",
      minimal: "low",
      xhigh: "high",
    });
  });

  it("compat に thinkingFormat がない場合は compat が undefined になる", async () => {
    const { resolveModel } = await importFresh();
    const { getProviders } = await import("@earendil-works/pi-ai");
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue([] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([
      {
        provider: "custom",
        baseUrl: "http://localhost:8080/v1",
        api: "openai-completions",
        compat: {},
      },
    ] as unknown as CredentialEntry[]);

    const model = await resolveModel("custom", "some-model");
    expect(model.compat).toBeUndefined();
    expect(model.reasoning).toBe(false);
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
    const { loadCredentialProxy } = await import(
      "../config/credential-proxy.js"
    );
    vi.mocked(getProviders).mockReturnValue(["openai"] as KnownProvider[]);
    vi.mocked(loadCredentialProxy).mockResolvedValue([]);
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
