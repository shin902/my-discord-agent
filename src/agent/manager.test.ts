import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  initManager,
  resetManagerDependencies,
  sendMessage,
  setManagerDependencies,
  type ManagerChildProcess,
  type ManagerDependencies,
  type ManagerSpawn,
  resolveBaseUrl,
  resolveModel,
  killAllRunningContainers,
  validateModel as managerValidateModel,
} from "./manager.js";
import { resolveTools as resolveConfiguredTools } from "../tools/registry.js";


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_ATTACHMENTS_DIR = path.join(
  __dirname,
  "../../data/attachments/test-group",
);

// sendMessage は groupName ごとに groups/{name}, data/sessions/{name} を
// 実ファイルシステムに mkdir する（manager.ts:236-238）。このテストファイルでは
// 任意の groupName が使われ得るため、テスト前後のディレクトリ一覧の差分から
// 新規作成分だけを特定して削除する（groupName をハードコードしない、issue #47）。
const GROUPS_DIR = path.join(__dirname, "../../groups");
const SESSIONS_DIR = path.join(__dirname, "../../data/sessions");

const listEntries = (dir: string) => readdir(dir).catch(() => []);

let groupsBefore: Set<string>;
let sessionsBefore: Set<string>;

beforeEach(async () => {
  configureManager();
  groupsBefore = new Set(await listEntries(GROUPS_DIR));
  sessionsBefore = new Set(await listEntries(SESSIONS_DIR));
});

afterEach(async () => {
  resetManagerDependencies();
  const [groupsAfter, sessionsAfter] = await Promise.all([
    listEntries(GROUPS_DIR),
    listEntries(SESSIONS_DIR),
  ]);
  const newDirs = [
    ...groupsAfter
      .filter((name) => !groupsBefore.has(name))
      .map((name) => path.join(GROUPS_DIR, name)),
    ...sessionsAfter
      .filter((name) => !sessionsBefore.has(name))
      .map((name) => path.join(SESSIONS_DIR, name)),
  ];
  await Promise.all(
    newDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

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
    const model = await resolveModel("zai", "glm-4.7-flash");
    expect(model.id).toBe("glm-4.7-flash");
  });

  it("不明なプロバイダはエラー", async () => {
    await expect(resolveModel("unknown-provider", "model-x")).rejects.toThrow(
      "不明なプロバイダ: unknown-provider",
    );
  });

  it("不明なモデルIDはエラー", async () => {
    await expect(resolveModel("anthropic", "unknown-model")).rejects.toThrow(
      "不明なモデル: unknown-model (provider: anthropic)",
    );
  });
});

interface ResolvedModel { provider: string; modelId: string; thinkingLevel?: string }

type SkillsMock = Mock<ManagerDependencies["ensureGroupSkills"]>;
type SpawnMock = Mock<ManagerSpawn>;

const getSpawnArgs = (spawnMock: SpawnMock, index = 0): string[] => {
  const args = spawnMock.mock.calls[index][1];
  if (!Array.isArray(args)) throw new Error("spawn args missing");
  return args;
};

const makeProc = (
  code: number | null = 0,
  stdout = "mocked response",
  stderr = "",
): ManagerChildProcess => {
  const proc: ManagerChildProcess = {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: {
      on: vi.fn((event: "data", cb: (chunk: Buffer) => void) => {
        if (event === "data") cb(Buffer.from(stdout));
      }),
    },
    stderr: {
      on: vi.fn((event: "data", cb: (chunk: Buffer) => void) => {
        if (event === "data" && stderr) cb(Buffer.from(stderr));
      }),
    },
    once: vi.fn((event: "close" | "error", cb: (value: number | null | Error) => void) => {
      if (event === "close") cb(code);
      return proc;
    }),
    on: vi.fn((event: "close" | "error", cb: (value: number | null | Error) => void) => {
      if (event === "close") cb(code);
      return proc;
    }),
    kill: vi.fn(),
  };
  return proc;
};

const configureManager = (
  overrides: Partial<ManagerDependencies> = {},
): void => {
  setManagerDependencies({
    spawn: vi.fn<ManagerSpawn>().mockReturnValue(makeProc()),
    loadCredentialProxy: vi.fn().mockResolvedValue([]),
    loadAgentTimeoutMs: vi.fn().mockResolvedValue(10 * 60 * 1000),
    resolveModelConfig: vi.fn().mockImplementation(
      async (model?: ResolvedModel): Promise<ResolvedModel> => ({
        provider: model?.provider ?? "zai",
        modelId: model?.modelId ?? "glm-4.7-flash",
        thinkingLevel: model?.thinkingLevel,
      }),
    ),
    findGroupByName: vi.fn().mockResolvedValue(undefined),
    ensureGroupSkills: vi.fn().mockResolvedValue(undefined),
    resolveTools: resolveConfiguredTools,
    validateModel: managerValidateModel,
    ...overrides,
  });
};

describe("sendMessage: Docker 起動構成", () => {
  let spawnMock: SpawnMock;

  beforeEach(async () => {
    spawnMock = vi.fn().mockReturnValue(makeProc());
    configureManager({ spawn: spawnMock });
    await initManager(12345);
  });

  afterEach(() => {
  });

  it("docker run --rm -i --pull=always --memory=512m --cpus=1 を含む", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    expect(args).toContain("--rm");
    expect(args).toContain("-i");
    expect(args).toContain("--pull=always");
    expect(args).toContain("--memory=512m");
    expect(args).toContain("--cpus=1");
  });

  it("SIGKILL などで null 終了したコンテナは成功レスポンスにせず再試行可能なエラーにする", async () => {
    spawnMock.mockReturnValueOnce(makeProc(null));

    await expect(sendMessage("test-group", "session-1", "hi")).rejects.toThrow(
      "コンテナがシグナルで終了しました",
    );
  });

  it("image pull とコンテナ内処理の所要時間を通知する", async () => {
    spawnMock.mockReturnValueOnce(
      makeProc(
        0,
        "response",
        [
          "latest: Pulling from my-discord-agent-runner",
          "Status: Image is up to date for localhost:5050/my-discord-agent-runner:latest",
          "",
        ].join("\n"),
      ),
    );
    const onExecutionTiming = vi.fn();

    await sendMessage(
      "test-group",
      "session-1",
      "hi",
      undefined,
      undefined,
      onExecutionTiming,
    );

    expect(onExecutionTiming).toHaveBeenCalledWith({
      termination: "close",
      exitCode: 0,
      preparationMs: expect.any(Number),
      dockerRunMs: expect.any(Number),
      imagePullMs: expect.any(Number),
      containerAndAgentMs: expect.any(Number),
    });
  });

  it("コンテナ内 stderr の Status 行を image pull 完了として扱わない", async () => {
    spawnMock.mockReturnValueOnce(makeProc(0, "response", "Status: 200 OK\n"));
    const onExecutionTiming = vi.fn();

    await sendMessage(
      "test-group",
      "session-1",
      "hi",
      undefined,
      undefined,
      onExecutionTiming,
    );

    const timing = onExecutionTiming.mock.calls[0][0];
    expect(timing.imagePullMs).toBeUndefined();
    expect(timing.containerAndAgentMs).toBeUndefined();
  });

  it("prompt完了後にプロセスが閉じない場合はtimeoutとして通知する", async () => {
    vi.useFakeTimers();
    try {
      const eventPayload = {
        type: "agent_timing",
        promptMs: 500_000,
        assistantTurns: 1,
        usage: {
          input: 46_821,
          output: 100,
          cacheRead: 40_000,
          cacheWrite: 0,
          totalTokens: 86_921,
        },
        stopReason: "stop",
      };
      const proc = makeProc(
        0,
        "response",
        `__DISCORD_EVENT__:${JSON.stringify(eventPayload)}\n`,
      );
      proc.on = vi.fn();
      spawnMock.mockReturnValueOnce(proc);
      const onExecutionTiming = vi.fn();

      const result = sendMessage(
        "test-group",
        "session-1",
        "hi",
        undefined,
        undefined,
        onExecutionTiming,
      );
      const rejection = expect(result).rejects.toThrow(
        "タイムアウト後のコンテナ後始末に失敗しました",
      );
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      await rejection;

      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
      expect(onExecutionTiming).toHaveBeenCalledWith(
        expect.objectContaining({
          termination: "timeout",
          promptMs: 500_000,
          postPromptMs: expect.any(Number),
          usage: eventPayload.usage,
          stopReason: "stop",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("killAllRunningContainers は実行中のコンテナ名を docker kill する", async () => {
    vi.useFakeTimers();
    try {
      const proc = makeProc();
      proc.on = vi.fn(); // close イベントを発火させず「実行中」の状態を維持する
      spawnMock.mockReturnValueOnce(proc);

      const sendPromise = sendMessage("test-group", "session-1", "hi");
      sendPromise.catch(() => {});
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());

      await killAllRunningContainers();

      // image pull 中（コンテナ未作成）でも docker run クライアント自体を
      // 直接 kill することで孤立を防ぐ
      expect(proc.kill).toHaveBeenCalledWith("SIGKILL");

      expect(spawnMock).toHaveBeenCalledTimes(2);
      const runArgs = getSpawnArgs(spawnMock, 0);
      const killArgs = getSpawnArgs(spawnMock, 1);
      const nameIndex = runArgs.indexOf("--name");
      expect(killArgs).toEqual(["kill", runArgs[nameIndex + 1]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("実行中のコンテナが無ければ killAllRunningContainers は何もしない", async () => {
    await killAllRunningContainers();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("--add-host=host.docker.internal:host-gateway を含む", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    expect(args).toContain("--add-host=host.docker.internal:host-gateway");
  });

  it("/sessions/{groupName} にグループ単位でmountする", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(
      volumeArgs.some(
        (v) =>
          v.includes("data/sessions/test-group") &&
          v.endsWith(":/sessions/test-group"),
      ),
    ).toBe(true);
    expect(volumeArgs.some((v) => v.endsWith(":/sessions"))).toBe(false);
  });

  it("/workspace を mount する", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(
      volumeArgs.some(
        (v) => v.includes("test-group") && v.includes(":/workspace"),
      ),
    ).toBe(true);
  });

  it("/config を mount しない", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs.some((v) => v.includes(":/config"))).toBe(false);
  });

  it("--user にホストのUID:GIDを渡し、HOME=/tmpを設定する", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const userIdx = args.indexOf("--user");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(args[userIdx + 1]).toBe(
      `${process.getuid?.()}:${process.getgid?.()}`,
    );
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envArgs).toContain("HOME=/tmp");
  });

  it("CREDENTIAL_PROXY_JSON 環境変数を渡す", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envArgs.some((v) => v.startsWith("CREDENTIAL_PROXY_JSON="))).toBe(
      true,
    );
  });

  it("CREDENTIAL_PROXY_PATH 環境変数を渡さない", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    expect(envArgs.some((v) => v.startsWith("CREDENTIAL_PROXY_PATH="))).toBe(
      false,
    );
  });

  it("node /app/runner.mjs で実行する", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const nodeIdx = args.indexOf("node");
    expect(nodeIdx).toBeGreaterThan(-1);
    expect(args[nodeIdx + 1]).toBe("/app/runner.mjs");
  });

  it("カスタムイメージを使用する", async () => {
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    expect(args).toContain("localhost:5050/my-discord-agent-runner:latest");
  });
});

describe("sendMessage: 添付ファイル", () => {
  let spawnMock: SpawnMock;
  let fetchMock: Mock<typeof fetch>;

  beforeEach(async () => {
    await rm(TEST_ATTACHMENTS_DIR, { recursive: true, force: true });
    spawnMock = vi.fn().mockReturnValue(makeProc());
    configureManager({ spawn: spawnMock });
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
    vi.stubGlobal("fetch", fetchMock);
    await initManager(12345);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(TEST_ATTACHMENTS_DIR, { recursive: true, force: true });
  });

  const attachments = [
    {
      url: "https://cdn.discordapp.com/attachments/x/y/photo.png",
      name: "photo.png",
      contentType: "image/png",
      size: 8,
    },
  ];

  it("添付ファイルを /workspace/attachments に読み取り専用でマウントする", async () => {
    await sendMessage(
      "test-group",
      "session-1",
      "見て",
      undefined,
      attachments,
    );

    expect(fetchMock).toHaveBeenCalledWith(attachments[0].url);
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(
      volumeArgs.some(
        (v) =>
          v.includes("data/attachments/test-group/session-1") &&
          v.endsWith(":/workspace/attachments:ro"),
      ),
    ).toBe(true);
  });

  it("プロンプトに添付ファイルのパス一覧を追記する", async () => {
    await sendMessage(
      "test-group",
      "session-1",
      "見て",
      undefined,
      attachments,
    );

    const proc = spawnMock.mock.results[0].value;
    const payload = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(payload.content).toContain("見て");
    expect(payload.content).toContain("[添付ファイル]");
    expect(payload.content).toContain("attachments/0-photo.png");
  });

  it("画像添付がある場合は read ツールでの確認を促すヒントを追記する", async () => {
    await sendMessage(
      "test-group",
      "session-1",
      "見て",
      undefined,
      attachments,
    );

    const proc = spawnMock.mock.results[0].value;
    const payload = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(payload.content).toContain("read ツール");
  });

  it("画像以外の添付ファイルのみの場合は read ツールのヒントを追記しない", async () => {
    await sendMessage("test-group", "session-1", "見て", undefined, [
      {
        url: "https://cdn.discordapp.com/attachments/x/y/note.txt",
        name: "note.txt",
        contentType: "text/plain",
        size: 8,
      },
    ]);

    const proc = spawnMock.mock.results[0].value;
    const payload = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(payload.content).not.toContain("read ツール");
  });

  it("添付ファイルがない場合はマウントせず content も変更しない", async () => {
    await sendMessage("test-group", "session-1", "hi");

    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs.some((v) => v.includes(":/workspace/attachments"))).toBe(
      false,
    );
    const proc = spawnMock.mock.results[0].value;
    const payload = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(payload.content).toBe("hi");
  });

  it("過去のメッセージで添付ディレクトリが作られていれば、添付なしの後続メッセージでもマウントする", async () => {

    await sendMessage(
      "test-group",
      "session-1",
      "見て",
      undefined,
      attachments,
    );

    await sendMessage("test-group", "session-1", "さっきの画像について教えて");

    const args = getSpawnArgs(spawnMock, 1);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(
      volumeArgs.some(
        (v) =>
          v.includes("data/attachments/test-group/session-1") &&
          v.endsWith(":/workspace/attachments:ro"),
      ),
    ).toBe(true);

    const proc = spawnMock.mock.results[1].value;
    const payload = JSON.parse(proc.stdin.write.mock.calls[1][0]);
    expect(payload.content).toBe("さっきの画像について教えて");
  });

  it("サイズが上限を超える添付ファイルはダウンロードしない", async () => {
    const tooLarge = [{ ...attachments[0], size: 11 * 1024 * 1024 }];
    await sendMessage("test-group", "session-1", "hi", undefined, tooLarge);

    expect(fetchMock).not.toHaveBeenCalled();
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs.some((v) => v.includes(":/workspace/attachments"))).toBe(
      false,
    );
  });
});

describe("sendMessage: 追加マウント (config/groups.json の mounts)", () => {
  let spawnMock: SpawnMock;

  const setup = async (mounts: Array<{ host: string; container: string; readOnly?: boolean }> | undefined) => {
    spawnMock = vi.fn().mockReturnValue(makeProc());
    configureManager({
      spawn: spawnMock,
      findGroupByName: vi.fn().mockResolvedValue({
        name: "test-group",
        channels: [],
        mounts,
      }),
    });
    await initManager(12345);
  };

  it("絶対パスの host を container にそのままマウントする", async () => {
    await setup([{ host: "/host/repo", container: "/repo" }]);
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs).toContain("/host/repo:/repo");
  });

  it("readOnly: true の場合は :ro が付与される", async () => {
    await setup([{ host: "/host/repo", container: "/repo", readOnly: true }]);
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs).toContain("/host/repo:/repo:ro");
  });

  it("相対パスの host は ROOT 基準で解決される", async () => {
    await setup([{ host: "relative/dir", container: "/relative" }]);
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(
      volumeArgs.some(
        (v) =>
          v.endsWith("relative/dir:/relative") && !v.startsWith("relative"),
      ),
    ).toBe(true);
  });

  it("mounts が未設定の場合は追加マウントなし", async () => {
    await setup(undefined);
    await sendMessage("test-group", "session-1", "hi");
    const args = getSpawnArgs(spawnMock, 0);
    const volumeArgs = args.filter((_, i) => args[i - 1] === "-v");
    expect(volumeArgs).toHaveLength(2);
  });

  it("相対パスの host がリポジトリルート外を指す場合は設定エラーを返す", async () => {
    await setup([{ host: "../outside", container: "/outside" }]);
    await expect(sendMessage("test-group", "session-1", "hi")).rejects.toThrow(
      /設定エラー.*リポジトリルート外/,
    );
  });
});

describe("sendMessage: CREDENTIAL_PROXY_JSON の内容", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const setup = async (creds: unknown[]) => {
    const spawnMock = vi.fn().mockReturnValue(makeProc());
    configureManager({
      spawn: spawnMock,
      loadCredentialProxy: vi.fn().mockResolvedValue(creds),
    });
    await initManager(12345);
    return spawnMock;
  };

  const getCredJson = (spawnMock: SpawnMock) => {
    const args = getSpawnArgs(spawnMock, 0);
    const envArgs = args.filter((_, i) => args[i - 1] === "-e");
    const credArg = envArgs.find((v) => v.startsWith("CREDENTIAL_PROXY_JSON="));
    return JSON.parse(credArg?.slice("CREDENTIAL_PROXY_JSON=".length) ?? "[]");
  };

  it("envVars ありのエントリが proxy URL に変換される", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = await setup([
      {
        provider: "test",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].baseUrl).toBe("http://host.docker.internal:12345/test");
  });

  it("proxy URL が http://host.docker.internal:{port}/{provider} 形式", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = await setup([
      {
        provider: "my-provider",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].baseUrl).toMatch(
      /^http:\/\/host\.docker\.internal:\d+\/my-provider$/,
    );
  });

  it("envVars フィールドが JSON に含まれない", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = await setup([
      {
        provider: "test",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].envVars).toBeUndefined();
  });

  it("google フィールドが JSON に含まれない", async () => {
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET = "test-secret";
    const spawnMock = await setup([
      {
        provider: "google-calendar",
        baseUrl: "https://www.googleapis.com/calendar/v3",
        google: {
          clientId: "test-client-id",
          clientSecretEnvVar: "GOOGLE_CALENDAR_CLIENT_SECRET",
          scopes: ["https://www.googleapis.com/auth/calendar"],
        },
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].google).toBeUndefined();
    expect(creds[0].provider).toBe("google-calendar");
  });

  it("redditCookie フィールドが JSON に含まれない", async () => {
    const spawnMock = await setup([
      {
        provider: "reddit",
        baseUrl: "https://www.reddit.com",
        redditCookie: {
          cookieFile: "data/reddit-cookies.json",
          maxAgeDays: 7,
        },
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].redditCookie).toBeUndefined();
    expect(creds[0].provider).toBe("reddit");
  });

  it("auth フィールドが JSON に含まれない", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = await setup([
      {
        provider: "test",
        envVars: ["TEST_API_KEY"],
        auth: { type: "query-token" },
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].auth).toBeUndefined();
  });

  it("api・reasoning 等の他フィールドは保持される", async () => {
    process.env.TEST_API_KEY = "test-key";
    const spawnMock = await setup([
      {
        provider: "test",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
        api: "openai-completions",
        reasoning: true,
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].api).toBe("openai-completions");
    expect(creds[0].reasoning).toBe(true);
  });

  it("baseUrl 未解決エントリは除外され warn ログが出る", async () => {
    process.env.TEST_API_KEY = "test-key";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const spawnMock = await setup([
      {
        provider: "good",
        envVars: ["TEST_API_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
      { provider: "bad", baseUrl: "https://api.example.com/{MISSING_VAR}/v1" },
    ]);
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
    const spawnMock = await setup([
      { provider: "local-llm", baseUrl: "http://192.168.40.65:8080/v1" },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds[0].provider).toBe("local-llm");
    expect(creds[0].baseUrl).toBe(
      "http://host.docker.internal:12345/local-llm",
    );
  });

  it("envVars がすべて未設定の場合はエントリを除外する", async () => {
    delete process.env.MISSING_KEY;
    const spawnMock = await setup([
      {
        provider: "test",
        envVars: ["MISSING_KEY"],
        baseUrl: "https://api.example.com/v1",
      },
    ]);
    await sendMessage("test-group", "session-1", "hi");
    const creds = getCredJson(spawnMock);
    expect(creds).toHaveLength(0);
  });
});

describe("sendMessage: 設定バリデーション", () => {
  beforeEach(() => {
  });

  afterEach(() => {
  });

  it("不正なツール名を持つグループ設定は設定エラーを返す", async () => {
    configureManager({
      findGroupByName: vi.fn().mockResolvedValue({
        name: "test-group",
        channels: [],
        tools: ["invalid"],
      }),
    });
    await initManager(12345);
    await expect(sendMessage("test-group", "session-1", "hi")).rejects.toThrow(
      "設定エラー: 不明なツール名: invalid",
    );
  });

  it("不正なプロバイダを持つグループ設定は設定エラーを返す", async () => {
    configureManager({
      findGroupByName: vi.fn().mockResolvedValue({
        name: "test-group",
        channels: [],
        model: { provider: "unknown", modelId: "x" },
      }),
    });
    await initManager(12345);
    await expect(sendMessage("test-group", "session-1", "hi")).rejects.toThrow(
      "設定エラー: 不明なプロバイダ: unknown",
    );
  });

  it("mounts.container が /workspace と重複する場合は設定エラーを返す", async () => {
    configureManager({
      findGroupByName: vi.fn().mockResolvedValue({
        name: "test-group",
        channels: [],
        mounts: [{ host: "/host/repo", container: "/workspace" }],
      }),
    });
    await initManager(12345);
    await expect(sendMessage("test-group", "session-1", "hi")).rejects.toThrow(
      /設定エラー.*\/workspace/,
    );
  });
});

describe("sendMessage: configOverride", () => {
  let spawnMock: SpawnMock;
  let ensureGroupSkillsMock: SkillsMock;

  const setup = async () => {
    spawnMock = vi.fn().mockReturnValue(makeProc());
    ensureGroupSkillsMock = vi.fn().mockResolvedValue(undefined);
    configureManager({
      spawn: spawnMock,
      ensureGroupSkills: ensureGroupSkillsMock,
      findGroupByName: vi.fn().mockResolvedValue({
        name: "test-group",
        channels: [],
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: ["read"],
        skills: ["base-skill"],
        allowMention: true,
      }),
    });
    await initManager(12345);
    return sendMessage;
  };

  afterEach(() => {
  });

  it("configOverride が payload の groupConfig を上書きする", async () => {
    const sendMessage = await setup();

    await sendMessage("test-group", "session-1", "hi", {
      configOverride: {
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: ["bash"],
        skills: ["override-skill"],
      },
    });

    const proc = spawnMock.mock.results[0].value;
    const payload = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(payload.groupConfig).toEqual(
      expect.objectContaining({
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: ["bash"],
        skills: ["override-skill"],
        allowMention: true,
      }),
    );
  });

  it("configOverride.skills 指定時だけ ensureGroupSkills を呼ぶ", async () => {
    const sendMessage = await setup();

    await sendMessage("test-group", "session-1", "hi", {
      configOverride: { skills: ["override-skill"] },
    });

    expect(ensureGroupSkillsMock).toHaveBeenCalledWith("test-group", [
      "override-skill",
    ]);

    ensureGroupSkillsMock.mockClear();
    await sendMessage("test-group", "session-2", "hi");
    expect(ensureGroupSkillsMock).not.toHaveBeenCalled();
  });

  it('configOverride.skills が "*" の場合は payload を上書きし、テンプレートコピーはしない', async () => {
    const sendMessage = await setup();

    await sendMessage("test-group", "session-1", "hi", {
      configOverride: { skills: "*" },
    });

    const proc = spawnMock.mock.results[0].value;
    const payload = JSON.parse(proc.stdin.write.mock.calls[0][0]);
    expect(payload.groupConfig).toEqual(
      expect.objectContaining({
        skills: "*",
      }),
    );
    expect(ensureGroupSkillsMock).not.toHaveBeenCalled();
  });
});

describe("sendMessage: onDiscordEvent コールバック", () => {
  const setupWithStderr = async (stderr: string, code = 0) => {
    const spawnMock = vi
      .fn()
      .mockReturnValue(makeProc(code, "response", stderr));
    configureManager({ spawn: spawnMock });
    await initManager(12345);
    return sendMessage;
  };

  afterEach(() => {
  });

  it("__DISCORD_EVENT__ 行はコールバックに渡される", async () => {
    const eventPayload = {
      type: "tool_start",
      toolName: "bash",
      args: { command: "ls" },
    };
    const sendMessage = await setupWithStderr(
      `__DISCORD_EVENT__:${JSON.stringify(eventPayload)}\n`,
    );

    const onDiscordEvent = vi.fn();
    await sendMessage("g", "s", "hi", onDiscordEvent);

    expect(onDiscordEvent).toHaveBeenCalledWith(eventPayload);
  });

  it("agent_timing はDiscordへ転送せず実行時間へ統合する", async () => {
    const eventPayload = {
      type: "agent_timing",
      promptMs: 1234,
      assistantTurns: 2,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 80,
        cacheWrite: 5,
        totalTokens: 205,
      },
      stopReason: "stop",
    };
    const sendMessage = await setupWithStderr(
      `__DISCORD_EVENT__:${JSON.stringify(eventPayload)}\n`,
    );
    const onDiscordEvent = vi.fn();
    const onExecutionTiming = vi.fn();

    await sendMessage(
      "g",
      "s",
      "hi",
      onDiscordEvent,
      undefined,
      onExecutionTiming,
    );

    expect(onDiscordEvent).not.toHaveBeenCalled();
    expect(onExecutionTiming).toHaveBeenCalledWith(
      expect.objectContaining({
        termination: "close",
        exitCode: 0,
        promptMs: 1234,
        postPromptMs: expect.any(Number),
        assistantTurns: 2,
        usage: eventPayload.usage,
        stopReason: "stop",
      }),
    );
  });

  it("stopReason=error は errorMessage がなくても失敗として伝播する", async () => {
    const eventPayload = {
      type: "agent_timing",
      promptMs: 1,
      assistantTurns: 1,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
      },
      stopReason: "error",
    };
    const sendMessage = await setupWithStderr(
      `__DISCORD_EVENT__:${JSON.stringify(eventPayload)}\n`,
    );

    await expect(sendMessage("g", "s", "hi")).rejects.toThrow(
      "assistant stopReason=error",
    );
  });

  it("通常の stderr はコールバックに渡されずエラー文字列に含まれる", async () => {
    const sendMessage = await setupWithStderr("plain error\n", 1);

    const onDiscordEvent = vi.fn();
    await expect(sendMessage("g", "s", "hi", onDiscordEvent)).rejects.toThrow(
      "plain error",
    );
    expect(onDiscordEvent).not.toHaveBeenCalled();
  });

  it("イベント行と通常行が混在した場合それぞれ適切に処理される", async () => {
    const eventPayload = { type: "error", message: "oops" };
    const sendMessage = await setupWithStderr(
      `log line\n__DISCORD_EVENT__:${JSON.stringify(eventPayload)}\nanother log\n`,
      1,
    );

    const onDiscordEvent = vi.fn();
    await expect(sendMessage("g", "s", "hi", onDiscordEvent)).rejects.toThrow(
      /log line[\s\S]*another log/,
    );
    expect(onDiscordEvent).toHaveBeenCalledWith(eventPayload);
  });

  it("コールバックなしでも正常に動作する", async () => {
    const sendMessage = await setupWithStderr(
      `__DISCORD_EVENT__:${JSON.stringify({ type: "tool_start", toolName: "x", args: {} })}\n`,
    );

    await expect(sendMessage("g", "s", "hi")).resolves.toBe("response");
  });
});
