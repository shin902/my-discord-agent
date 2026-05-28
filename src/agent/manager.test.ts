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

const makeProc = (code = 0, stdout = "mocked response", stderr = "") => ({
  stdin: { write: vi.fn(), end: vi.fn() },
  stdout: {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data") cb(Buffer.from(stdout));
    }),
  },
  stderr: {
    on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
      if (event === "data" && stderr) cb(Buffer.from(stderr));
    }),
  },
  on: vi.fn((event: string, cb: (code: number) => void) => {
    if (event === "close") cb(code);
  }),
  kill: vi.fn(),
});

describe("sendMessage: Docker 起動構成", () => {
  let spawnMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    spawnMock = vi.fn().mockReturnValue(makeProc());
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock("../proxy/credential-proxy-server.js", () => ({
      getProxyPort: vi.fn().mockReturnValue(12345),
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("docker run --rm -i --pull=always を含む", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--rm");
    expect(args).toContain("-i");
    expect(args).toContain("--pull=always");
  });

  it("--add-host=host.docker.internal:host-gateway を含む", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--add-host=host.docker.internal:host-gateway");
  });

  it("/sessions を mount する", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs.some((v) => v.includes(":/sessions"))).toBe(true);
  });

  it("/workspace を mount する", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(
      volumeArgs.some(
        (v) => v.includes("test-group") && v.includes(":/workspace"),
      ),
    ).toBe(true);
  });

  it("/config を mount しない", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs.some((v) => v.includes(":/config"))).toBe(false);
  });

  it("CREDENTIAL_PROXY_JSON 環境変数を渡す", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envArgs.some((v) => v.startsWith("CREDENTIAL_PROXY_JSON="))).toBe(
      true,
    );
  });

  it("CREDENTIAL_PROXY_PATH 環境変数を渡さない", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envArgs.some((v) => v.startsWith("CREDENTIAL_PROXY_PATH="))).toBe(
      false,
    );
  });

  it("node /app/runner.mjs で実行する", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    const nodeIdx = args.indexOf("node");
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(args[nodeIdx + 1]).toBe("/app/runner.mjs");
  });

  it("カスタムイメージを使用する", async () => {
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("localhost:5050/my-discord-agent-runner:latest");
  });
});

describe("sendMessage: CREDENTIAL_PROXY_JSON の内容", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.resetModules();
  });

  const setup = (creds: unknown[]) => {
    const spawnMock = vi.fn().mockReturnValue(makeProc());
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue(creds),
    }));
    vi.doMock("../config/group-config.js", () => ({
      loadGroupConfig: vi.fn().mockResolvedValue({}),
    }));
    vi.doMock("../proxy/credential-proxy-server.js", () => ({
      getProxyPort: vi.fn().mockReturnValue(12345),
    }));
    return spawnMock;
  };

  const getCredJson = (spawnMock: ReturnType<typeof vi.fn>) => {
    const args = spawnMock.mock.calls[0][1] as string[];
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    const credArg = envArgs.find((v) => v.startsWith("CREDENTIAL_PROXY_JSON="));
    return JSON.parse(credArg!.slice("CREDENTIAL_PROXY_JSON=".length));
  };

  it("envVars ありのエントリが proxy URL に変換される", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = setup([
      {
        provider: "test",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].baseUrl).toBe("http://host.docker.internal:12345/test");
  });

  it("proxy URL が http://host.docker.internal:{port}/{provider} 形式", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = setup([
      {
        provider: "my-provider",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].baseUrl).toMatch(
      /^http:\/\/host\.docker\.internal:\d+\/my-provider$/,
    );
  });

  it("envVars フィールドが JSON に含まれない", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = setup([
      {
        provider: "test",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].envVars).toBeUndefined();
  });

  it("api・reasoning 等の他フィールドは保持される", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = setup([
      {
        provider: "test",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        reasoning: true,
      },
    ]);
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].api).toBe("openai-completions");
    expect(creds[0].reasoning).toBe(true);
  });

  it("baseUrl 未解決エントリは除外され warn ログが出る", async () => {
    process.env.TEST_API_KEY = "test-key";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawnMock = setup([
      {
        provider: "good",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
      { provider: "bad", baseUrl: "https://api.example.com/{MISSING_VAR}/v1" },
    ]);
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds).toHaveLength(1);
    expect(creds[0].provider).toBe("good");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "bad: baseUrl に未解決のプレースホルダがあります",
      ),
    );
    warnSpy.mockRestore();
  });

  it("envVars なしのローカルLLMエントリも含まれる", async () => {
    const spawnMock = setup([
      { provider: "local-llm", baseUrl: "http://192.168.40.65:8080/v1" },
    ]);
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].provider).toBe("local-llm");
    expect(creds[0].baseUrl).toBe(
      "http://host.docker.internal:12345/local-llm",
    );
  });

  it("envVars がすべて未設定の場合はエントリを除外する", async () => {
    delete process.env.MISSING_KEY;
    const spawnMock = setup([
      {
        provider: "test",
        envVars: ["MISSING_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    const { sendMessage } = await import("./manager.js");
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds).toHaveLength(0);
  });
});

describe("sendMessage: 設定バリデーション", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("node:child_process", () => ({
      spawn: vi.fn().mockReturnValue(makeProc()),
    }));
    vi.doMock("../config/credential-proxy.js", () => ({
      loadCredentialProxy: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../proxy/credential-proxy-server.js", () => ({
      getProxyPort: vi.fn().mockReturnValue(12345),
    }));
  });

  afterEach(() => {
    vi.resetModules();
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
