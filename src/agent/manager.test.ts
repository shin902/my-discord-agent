import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", () => ({
  getProviders: () => ["provider-a", "opencode-go"],
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
    process.env.CLOUDFLARE_ACCOUNT_ID = "abc123";
    const result = resolveBaseUrl(
      "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    );
    expect(result).toBe(
      "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1",
    );
  });

  it("未解決のプレースホルダがあると null を返す", () => {
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    const result = resolveBaseUrl(
      "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    );
    expect(result).toBeNull();
  });

  it("小文字のプレースホルダも置換される", () => {
    process.env.aws_region = "ap-northeast-1";
    const result = resolveBaseUrl(
      "https://bedrock-runtime.{aws_region}.amazonaws.com",
    );
    expect(result).toBe("https://bedrock-runtime.ap-northeast-1.amazonaws.com");
  });

  it("未解決の小文字プレースホルダがあると null を返す", () => {
    delete process.env.aws_region;
    const result = resolveBaseUrl(
      "https://bedrock-runtime.{aws_region}.amazonaws.com",
    );
    expect(result).toBeNull();
  });

  it("プレースホルダがない URL はそのまま返す", () => {
    const result = resolveBaseUrl("https://api.openai.com/v1");
    expect(result).toBe("https://api.openai.com/v1");
  });
});

describe("resolveModel", () => {
  it("有効なプロバイダとモデルIDはモデルを返す", async () => {
    const model = await resolveModel("provider-a", "model-x");
    expect(model.id).toBe("model-x");
  });

  it("不明なプロバイダはエラー", async () => {
    await expect(resolveModel("unknown-provider", "model-x")).rejects.toThrow(
      "不明なプロバイダ: unknown-provider",
    );
  });

  it("不明なモデルIDはエラー", async () => {
    await expect(resolveModel("provider-a", "unknown-model")).rejects.toThrow(
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
      replace: vi.fn().mockReturnThis(),
      volume: vi.fn().mockReturnThis(),
      network: vi.fn().mockReturnThis(),
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
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("mocked response");
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
          provider: "test-provider",
          envVars: ["MISSING_VAR"],
          baseUrl: "https://api.example.com/{MISSING_VAR}",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("mocked response");
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

  it("envVars がすべて未設定の場合は静かにスキップする", async () => {
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
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("mocked response");
    expect(secretMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("envVars が一部未設定の場合は警告を出して注入する", async () => {
    process.env.PARTIAL_KEY_1 = "value1";
    delete process.env.PARTIAL_KEY_2;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "test-provider",
          envVars: ["PARTIAL_KEY_1", "PARTIAL_KEY_2"],
          baseUrl: "https://api.example.com",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("mocked response");
    expect(secretMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("test-provider: 一部の環境変数が未設定です"),
    );
    warnSpy.mockRestore();
  });

  it("envVars が省略された場合は secret 注入をスキップする", async () => {
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "local-llm",
          baseUrl: "http://localhost:8080/v1",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("mocked response");
    expect(secretMock).not.toHaveBeenCalled();
  });

  it("envVars が空配列の場合も secret 注入をスキップする", async () => {
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "local-llm",
          envVars: [],
          baseUrl: "http://localhost:8080/v1",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("mocked response");
    expect(secretMock).not.toHaveBeenCalled();
  });

  it("envVars がある場合は secret 注入と allowHost を行う", async () => {
    process.env.API_KEY = "primary-value";
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([
        {
          provider: "test",
          envVars: ["API_KEY"],
          baseUrl: "https://api.example.com",
        },
      ]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));

    const { sendMessage } = await import("./manager.js");
    const result = await sendMessage("test-group", "session-1", "hi");

    expect(result).toBe("mocked response");
    expect(secretMock).toHaveBeenCalledTimes(1);
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
      replace: vi.fn().mockReturnThis(),
      volume: vi.fn().mockReturnThis(),
      network: vi.fn().mockReturnThis(),
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
