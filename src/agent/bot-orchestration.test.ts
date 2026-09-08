import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  sendMessage,
  findGroupByName,
  loadBotRegistry,
  acquireLlmLock,
  resolveProviderConcurrency,
  repository,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  findGroupByName: vi.fn(),
  loadBotRegistry: vi.fn(),
  acquireLlmLock: vi.fn().mockResolvedValue(vi.fn()),
  resolveProviderConcurrency: vi.fn().mockResolvedValue("serial"),
  repository: {
    listBotTaskSessions: vi.fn(),
    createBotTaskSessionAndAdmission: vi.fn(() => ({
      session: {
        sessionId: "bot-task-1",
        handle: "task-abc123",
        groupName: "main",
        botId: "coding",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        preview: "inspect",
      },
      admission: { jobId: "admission-1", sessionId: "bot-task-1", sequence: 0 },
    })),
    resumeBotTaskSessionAndAdmission: vi.fn(() => ({
      session: {
        sessionId: "bot-task-1",
        handle: "task-abc123",
        groupName: "main",
        botId: "coding",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUsedAt: "2026-01-01T00:00:00.000Z",
        preview: "inspect",
      },
      admission: { jobId: "admission-1", sessionId: "bot-task-1", sequence: 0 },
    })),
    admitBotTaskSessionAdmission: vi.fn().mockReturnValue(true),
    tryAdmitBotTaskSessionAdmission: vi.fn().mockReturnValue("admitted"),
    completeBotTaskSessionAdmission: vi.fn(),
    cancelBotTaskSessionAdmission: vi.fn(),
  },
}));

vi.mock("./manager.js", () => ({ sendMessage }));
vi.mock("../config/groups.js", () => ({ findGroupByName }));
vi.mock("../config/bots.js", () => ({
  loadBotRegistry,
  resolveBotProfile: (
    registry: Record<string, unknown>,
    botId: string,
    group: string,
  ) => {
    const profile = registry[botId] as { group?: string } | undefined;
    if (!profile) throw new Error(`Botが未定義です: ${botId}`);
    if (profile.group !== group)
      throw new Error(`Bot ${botId} はグループ ${group} から利用できません`);
    return profile;
  },
}));
vi.mock("../config/agent-resolution.js", () => ({
  resolveAgentConfig: vi.fn(() => ({ model: { provider: "p", modelId: "m" } })),
}));
vi.mock("../config/default-model.js", () => ({
  resolveModelConfig: vi.fn(async (model: unknown) => model),
}));
vi.mock("../config/providers.js", () => ({ resolveProviderConcurrency }));
vi.mock("../queue/llm-mutex.js", () => ({ acquireLlmLock }));
vi.mock("../queue/repository.js", () => ({
  getQueueRepository: () => repository,
}));

const { handleBotToolRequest } = await import("./bot-orchestration.js");

class MockRequest extends EventEmitter {
  headers: Record<string, string> = {};
  constructor(private readonly body: string) {
    super();
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    yield this.body;
  }
}

function response() {
  const result = new EventEmitter() as EventEmitter & {
    headersSent: boolean;
    writableEnded: boolean;
    writeHead: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  result.headersSent = false;
  result.writableEnded = false;
  result.writeHead = vi.fn();
  result.end = vi.fn(() => {
    result.writableEnded = true;
  });
  return result;
}

function invoke(
  req: MockRequest,
  res: ReturnType<typeof response>,
  heldProvider?: string,
  scope?: string,
  trustedDiscordDestination?: {
    botId: string;
    channelId: string;
  },
) {
  return handleBotToolRequest(
    req as unknown as import("node:http").IncomingMessage,
    res as unknown as import("node:http").ServerResponse,
    scope,
    heldProvider,
    trustedDiscordDestination,
  );
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "bot-task-1",
    handle: "task-abc123",
    groupName: "main",
    botId: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastUsedAt: "2026-01-01T00:00:00.000Z",
    preview: "inspect",
    ...overrides,
  };
}

describe("handleBotToolRequest", () => {
  afterEach(() => vi.clearAllMocks());

  it("runはTask Sessionを作成してBot実行完了後に結果を返す", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({
      coding: { group: "main", instructions: "code", tools: ["bot"] },
    });
    sendMessage.mockResolvedValue("調査結果");
    const req = new MockRequest(
      JSON.stringify({
        groupName: "main",
        action: "run",
        bot: "coding",
        prompt: "inspect",
      }),
    );
    const res = response();

    await invoke(req, res);

    expect(repository.createBotTaskSessionAndAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "coding", preview: "inspect" }),
    );
    expect(repository.admitBotTaskSessionAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "admission-1" }),
    );
    expect(repository.completeBotTaskSessionAdmission).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      "main",
      "bot-task-1",
      "inspect",
      expect.objectContaining({ enableBotTool: false }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      content: "調査結果",
      session: "task-abc123",
    });
  });

  it("internal contextのtrusted destinationをnested実行へ渡す", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({
      coding: { group: "main", instructions: "code" },
    });
    sendMessage.mockResolvedValue("調査結果");
    const req = new MockRequest(
      JSON.stringify({
        groupName: "main",
        action: "run",
        bot: "coding",
        prompt: "inspect",
      }),
    );
    const res = response();

    await invoke(req, res, undefined, undefined, {
      botId: "secondary",
      channelId: "channel-1",
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "main",
      "bot-task-1",
      "inspect",
      expect.objectContaining({
        trustedDiscordDestination: {
          botId: "secondary",
          channelId: "channel-1",
        },
      }),
    );
  });

  it("resumeは同じ所有者のTask Sessionだけを使い同期実行する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({
      coding: { group: "main", instructions: "code" },
    });
    repository.resumeBotTaskSessionAndAdmission.mockReturnValue({
      session: session(),
      admission: { jobId: "admission-1", sessionId: "bot-task-1", sequence: 0 },
    });
    sendMessage.mockResolvedValue("続きの結果");
    const req = new MockRequest(
      JSON.stringify({
        groupName: "main",
        action: "resume",
        bot: "coding",
        session: "task-abc123",
        prompt: "continue",
      }),
    );
    const res = response();

    await invoke(req, res);

    expect(repository.resumeBotTaskSessionAndAdmission).toHaveBeenCalledWith(
      "task-abc123",
      "main",
      "coding",
      expect.any(String),
    );
    expect(repository.completeBotTaskSessionAdmission).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      "main",
      "bot-task-1",
      "continue",
      expect.any(Object),
    );
  });

  it("listはgroupとBotの所有境界内の一覧を返す", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({
      coding: { group: "main", instructions: "code" },
    });
    repository.listBotTaskSessions.mockReturnValue([session()]);
    const req = new MockRequest(
      JSON.stringify({
        groupName: "main",
        action: "list",
        bot: "coding",
      }),
    );
    const res = response();

    await invoke(req, res);

    expect(repository.listBotTaskSessions).toHaveBeenCalledWith(
      "main",
      "coding",
    );
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      content: expect.stringContaining("task-abc123"),
    });
  });

  it("親と同じserial providerはlockを再取得せず完了する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    sendMessage.mockResolvedValue("結果");

    await invoke(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "run",
          bot: "coding",
          prompt: "inspect",
        }),
      ),
      response(),
      "p",
    );

    expect(acquireLlmLock).not.toHaveBeenCalled();
  });

  it("先行処理がある同じserial providerの同期resumeは待たずに拒否する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    repository.tryAdmitBotTaskSessionAdmission.mockReturnValueOnce("blocked");
    const res = response();

    await invoke(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "resume",
          bot: "coding",
          session: "task-abc123",
          prompt: "inspect",
        }),
      ),
      res,
      "p",
    );

    expect(repository.tryAdmitBotTaskSessionAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "admission-1" }),
    );
    expect(repository.cancelBotTaskSessionAdmission).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "admission-1" }),
    );
    expect(repository.admitBotTaskSessionAdmission).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0]).error).toContain(
      "先行するBot Task Session処理",
    );
  });

  it("親が別のserial providerを保持中なら同期Bot呼び出しを拒否する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    resolveProviderConcurrency.mockResolvedValueOnce("serial");
    const res = response();

    await invoke(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "run",
          bot: "coding",
          prompt: "inspect",
        }),
      ),
      res,
      "other-provider",
    );

    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0]).error).toContain(
      "異なるserial providerへの同期Bot呼び出しは利用できません",
    );
    expect(acquireLlmLock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("親lockなしのserial providerはlockを取得し、エラー時も解放する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    const release = vi.fn();
    acquireLlmLock.mockResolvedValueOnce(release);
    resolveProviderConcurrency.mockResolvedValueOnce("serial");
    sendMessage.mockRejectedValueOnce(new Error("failed"));

    await invoke(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "run",
          bot: "coding",
          prompt: "inspect",
        }),
      ),
      response(),
    );

    expect(acquireLlmLock).toHaveBeenCalledWith(
      "p",
      "serial",
      expect.any(AbortSignal),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("同じparallel providerでは先行処理を待って実行する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    resolveProviderConcurrency.mockResolvedValueOnce("parallel");
    sendMessage.mockResolvedValueOnce("結果");

    await invoke(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "resume",
          bot: "coding",
          session: "task-abc123",
          prompt: "inspect",
        }),
      ),
      response(),
      "p",
    );

    expect(repository.tryAdmitBotTaskSessionAdmission).not.toHaveBeenCalled();
    expect(repository.admitBotTaskSessionAdmission).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it("parallel providerはlock待機なしで実行し、releaseはnoop契約に委ねる", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    resolveProviderConcurrency.mockResolvedValueOnce("parallel");
    sendMessage.mockResolvedValueOnce("結果");

    await invoke(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "run",
          bot: "coding",
          prompt: "inspect",
        }),
      ),
      response(),
      "other-provider",
    );

    expect(acquireLlmLock).toHaveBeenCalledWith(
      "p",
      "parallel",
      expect.any(AbortSignal),
    );
  });

  it("実行中のabortでも取得済みlockを解放する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    const release = vi.fn();
    acquireLlmLock.mockResolvedValueOnce(release);
    const req = new MockRequest(
      JSON.stringify({
        groupName: "main",
        action: "run",
        bot: "coding",
        prompt: "inspect",
      }),
    );
    sendMessage.mockImplementationOnce(async () => {
      req.emit("aborted");
      throw new Error("aborted");
    });

    await invoke(req, response());

    expect(release).toHaveBeenCalledOnce();
  });

  it("lock待機中のabortでは取得後のreleaseなしで失敗する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    acquireLlmLock.mockRejectedValueOnce(new Error("provider lock aborted"));

    await invoke(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "run",
          bot: "coding",
          prompt: "inspect",
        }),
      ),
      response(),
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("token scopeを越えるgroupのBotは拒否する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    const req = new MockRequest(
      JSON.stringify({
        groupName: "other",
        action: "run",
        bot: "coding",
        prompt: "inspect",
      }),
    );
    const res = response();

    await invoke(req, res, undefined, "main");

    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(findGroupByName).not.toHaveBeenCalled();
  });

  it("異なるgroupのBotは拒否する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({
      coding: { group: "private", instructions: "code" },
    });
    const req = new MockRequest(
      JSON.stringify({
        groupName: "main",
        action: "run",
        bot: "coding",
        prompt: "inspect",
      }),
    );
    const res = response();

    await invoke(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
