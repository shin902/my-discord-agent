import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: () => ["provider-a", "opencode-go", "azure-openai-responses"],
  getModels: (provider: string) =>
    provider === "opencode-go"
      ? [{ id: "kimi-k2.6", name: "Kimi K2.6" }]
      : [{ id: "model-x", name: "Model X" }],
}));

const { resolveModel, resolveBaseUrl } = await import("./manager.js");

describe("resolveBaseUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("プレースホルダが環境変数で置換される", () => {
    process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";
    const result = resolveBaseUrl(
      "https://{AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1",
    );
    expect(result).toBe("https://my-resource.openai.azure.com/openai/v1");
  });

  it("未解決のプレースホルダがあると null を返す", () => {
    delete process.env.AZURE_OPENAI_RESOURCE_NAME;
    const result = resolveBaseUrl(
      "https://{AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1",
    );
    expect(result).toBeNull();
  });

  it("プレースホルダがない URL はそのまま返す", () => {
    const result = resolveBaseUrl("https://api.openai.com/v1");
    expect(result).toBe("https://api.openai.com/v1");
  });
});

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

describe("sendMessage: credential-proxy 処理", () => {
  const originalEnv = process.env;
  const secretMock = vi.fn();
  let builderChain: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    secretMock.mockClear();
    secretMock.mockReturnThis();
    builderChain = {
      image: vi.fn().mockReturnThis(),
      workdir: vi.fn().mockReturnThis(),
      cpus: vi.fn().mockReturnThis(),
      memory: vi.fn().mockReturnThis(),
      env: vi.fn().mockReturnThis(),
      volume: vi.fn().mockReturnThis(),
      secret: secretMock,
      create: vi.fn().mockResolvedValue({
        [Symbol.asyncDispose]: vi.fn().mockResolvedValue(undefined),
        execWith: vi.fn().mockResolvedValue({
          code: 0,
          stdout: vi.fn().mockReturnValue("mocked response"),
          stderr: vi.fn().mockReturnValue(""),
        }),
      }),
    };
    vi.doMock("microsandbox", () => ({
      Sandbox: { builder: vi.fn().mockReturnValue(builderChain) },
    }));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("envVars に設定されているものがすべて secret として注入される", async () => {
    process.env.API_KEY = "primary-value";
    process.env.FALLBACK_KEY = "fallback-value";
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "test",
          envVars: ["API_KEY", "FALLBACK_KEY"],
          baseUrl: "https://api.example.com",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");

    expect(secretMock).toHaveBeenCalledTimes(2);
    const sb1 = {
      env: vi.fn().mockReturnThis(),
      value: vi.fn().mockReturnThis(),
      placeholder: vi.fn().mockReturnThis(),
      allowHost: vi.fn().mockReturnThis(),
      injectHeaders: vi.fn().mockReturnThis(),
    };
    secretMock.mock.calls[0][0](sb1);
    expect(sb1.env).toHaveBeenCalledWith("API_KEY");

    const sb2 = {
      env: vi.fn().mockReturnThis(),
      value: vi.fn().mockReturnThis(),
      placeholder: vi.fn().mockReturnThis(),
      allowHost: vi.fn().mockReturnThis(),
      injectHeaders: vi.fn().mockReturnThis(),
    };
    secretMock.mock.calls[1][0](sb2);
    expect(sb2.env).toHaveBeenCalledWith("FALLBACK_KEY");
  });

  it("overrideUrlEnvVar が設定されていれば baseUrl を上書きする", async () => {
    process.env.AZURE_OPENAI_API_KEY = "azure-key";
    process.env.AZURE_OPENAI_BASE_URL = "https://custom.azure.com/openai/v1";
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "azure-openai-responses",
          envVars: ["AZURE_OPENAI_API_KEY"],
          baseUrl:
            "https://{AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1",
          overrideUrlEnvVar: "AZURE_OPENAI_BASE_URL",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");

    expect(secretMock).toHaveBeenCalledTimes(1);
    const secretBuilder = secretMock.mock.calls[0][0];
    const sb = {
      env: vi.fn().mockReturnThis(),
      value: vi.fn().mockReturnThis(),
      placeholder: vi.fn().mockReturnThis(),
      allowHost: vi.fn().mockReturnThis(),
      injectHeaders: vi.fn().mockReturnThis(),
    };
    secretBuilder(sb);
    expect(sb.allowHost).toHaveBeenCalledWith("custom.azure.com");
  });

  it("baseUrl のプレースホルダが未解決の場合はスキップする", async () => {
    process.env.OPENAI_API_KEY = "openai-key";
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "openai",
          envVars: ["OPENAI_API_KEY"],
          baseUrl: "https://api.openai.com/v1",
        },
        {
          provider: "azure-openai-responses",
          envVars: ["AZURE_OPENAI_API_KEY"],
          baseUrl:
            "https://{AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");

    expect(secretMock).toHaveBeenCalledTimes(1);
    const secretBuilder = secretMock.mock.calls[0][0];
    const sb = {
      env: vi.fn().mockReturnThis(),
      value: vi.fn().mockReturnThis(),
      placeholder: vi.fn().mockReturnThis(),
      allowHost: vi.fn().mockReturnThis(),
      injectHeaders: vi.fn().mockReturnThis(),
    };
    secretBuilder(sb);
    expect(sb.env).toHaveBeenCalledWith("OPENAI_API_KEY");
  });

  it("envVars がすべて未設定の場合は警告を出してスキップする", async () => {
    delete process.env.MISSING_KEY_1;
    delete process.env.MISSING_KEY_2;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "test-provider",
          envVars: ["MISSING_KEY_1", "MISSING_KEY_2"],
          baseUrl: "https://api.example.com",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");

    expect(secretMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "test-provider: 必要な環境変数が設定されていません",
      ),
    );
    warnSpy.mockRestore();
  });
});

describe("sendMessage: 設定バリデーション", () => {
  beforeEach(() => {
    vi.resetModules();
    const builderChain = {
      image: vi.fn().mockReturnThis(),
      workdir: vi.fn().mockReturnThis(),
      cpus: vi.fn().mockReturnThis(),
      memory: vi.fn().mockReturnThis(),
      env: vi.fn().mockReturnThis(),
      volume: vi.fn().mockReturnThis(),
      secret: vi.fn().mockReturnThis(),
      create: vi.fn().mockResolvedValue({
        execWith: vi.fn().mockResolvedValue({
          code: 0,
          stdout: vi.fn().mockReturnValue("mocked response"),
          stderr: vi.fn().mockReturnValue(""),
        }),
      }),
    };
    vi.doMock("microsandbox", () => ({
      Sandbox: { builder: vi.fn().mockReturnValue(builderChain) },
    }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([]),
    }));
  });

  it("不正なツール名を持つグループ設定は設定エラーを返す", async () => {
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({ tools: ["invalid"] }),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("設定エラー: 不明なツール名: invalid");
  });

  it("不正なプロバイダを持つグループ設定は設定エラーを返す", async () => {
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi
        .fn()
        .mockResolvedValue({ model: { provider: "unknown", modelId: "x" } }),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("設定エラー: 不明なプロバイダ: unknown");
  });
});
