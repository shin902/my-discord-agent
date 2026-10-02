import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  sendMessage,
  findGroupByName,
  loadBotRegistry,
  acquireInferenceLock,
  resolveProviderLockTarget,
  repository,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  findGroupByName: vi.fn(),
  loadBotRegistry: vi.fn(),
  acquireInferenceLock: vi.fn().mockResolvedValue(vi.fn()),
  resolveProviderLockTarget: vi
    .fn()
    .mockResolvedValue({ provider: "p", resource: "p", concurrency: "serial" }),
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

vi.mock("./session.js", () => ({
  appendMessage: vi.fn().mockResolvedValue(undefined),
  loadMessages: vi
    .fn()
    .mockResolvedValue([
      { customType: "system-prompt-snapshot", content: "saved role" },
    ]),
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
vi.mock("../config/providers.js", () => ({ resolveProviderLockTarget }));
vi.mock("../queue/inference-lock.js", async (original) => ({
  ...(await original<typeof import("../queue/inference-lock.js")>()),
  acquireInferenceLock,
}));
vi.mock("../queue/repository.js", () => ({
  getQueueRepository: () => repository,
}));

const { createHeldInferenceResource } = await import(
  "../queue/inference-lock.js"
);

const { handleBotToolRequest } = await import("./bot-orchestration.js");
const { appendMessage } = await import("./session.js");

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
  heldResource?: string | { resource: string; provider: string },
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
    heldResource === undefined
      ? undefined
      : createHeldInferenceResource(
          typeof heldResource === "string"
            ? { resource: heldResource, provider: heldResource }
            : heldResource,
        ),
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
      expect.objectContaining({
        enableBotTool: false,
        systemPromptSnapshotContent: "saved role",
        systemPromptSnapshotPresent: true,
      }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      content: "調査結果",
      session: "task-abc123",
    });
  });

  it("snapshot保存に失敗した新規Taskをadmit・実行しない", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({
      coding: { group: "main", instructions: "code" },
    });
    vi.mocked(appendMessage).mockRejectedValueOnce(
      new Error("snapshot write failed"),
    );
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
    );
    expect(repository.createBotTaskSessionAndAdmission).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(JSON.parse(res.end.mock.calls[0][0]).error).toBe(
      "snapshot write failed",
    );
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

  it.each([
    "serial",
    8,
    "parallel",
  ] as const)("親と同じ共有resourceは枠を借りて完了する (%s)", async (concurrency) => {
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "p",
      resource: "resource:gpu",
      concurrency,
    });
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
      { resource: "resource:gpu", provider: "p" },
    );

    expect(sendMessage).toHaveBeenCalledOnce();
    expect(acquireInferenceLock).not.toHaveBeenCalled();
  });

  it.each([
    "serial",
    8,
    "parallel",
  ] as const)("先行処理がある同じ共有resourceの同期resumeは待たずに拒否する (%s)", async (concurrency) => {
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "p",
      resource: "resource:gpu",
      concurrency,
    });
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
      { resource: "resource:gpu", provider: "p" },
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

  it.each([
    "serial",
    8,
  ] as const)("親が別の有限resourceを保持中なら同期Bot呼び出しを拒否する (%s)", async (concurrency) => {
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "p",
      resource: "p",
      concurrency,
    });
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
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
      "異なるresourceまたはproviderへの同期Bot呼び出しは利用できません",
    );
    expect(acquireInferenceLock).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    "serial",
    "parallel",
    3,
  ] as const)("同じresourceの別providerへの同期呼び出しを拒否する (%s)", async (concurrency) => {
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "child",
      resource: "resource:gpu",
      concurrency,
    });
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
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
      "resource:gpu",
    );
    expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(acquireInferenceLock).not.toHaveBeenCalled();
    expect(repository.createBotTaskSessionAndAdmission).not.toHaveBeenCalled();
  });

  it("親lockなしのserial providerはlockを取得し、エラー時も解放する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    const release = vi.fn();
    acquireInferenceLock.mockResolvedValueOnce(release);
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "p",
      resource: "p",
      concurrency: "serial",
    });
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

    expect(acquireInferenceLock).toHaveBeenCalledWith(
      { provider: "p", resource: "p", concurrency: "serial" },
      "serial",
      expect.any(AbortSignal),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("同じparallel providerでは先行処理を待って実行する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "p",
      resource: "p",
      concurrency: "parallel",
    });
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

  it("専用resourceのparallel providerは親のresourceに関係なく実行できる", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "p",
      resource: "p",
      concurrency: "parallel",
    });
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

    expect(acquireInferenceLock).toHaveBeenCalledWith(
      { provider: "p", resource: "p", concurrency: "parallel" },
      "parallel",
      expect.any(AbortSignal),
    );
  });

  it("実行中のabortでも取得済みlockを解放する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    const release = vi.fn();
    acquireInferenceLock.mockResolvedValueOnce(release);
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

  it("親の終了は借用中の子をabortし、その実行がsettleするまで待つ", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    resolveProviderLockTarget.mockResolvedValueOnce({
      provider: "p",
      resource: "p",
      concurrency: 8,
    });
    const held = createHeldInferenceResource({ resource: "p", provider: "p" });
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      finishCleanup = resolve;
    });
    let childSignal: AbortSignal | undefined;
    sendMessage.mockImplementationOnce(
      async (_group, _session, _prompt, options) => {
        childSignal = options.signal;
        await cleanup;
        throw new Error("child aborted");
      },
    );
    const res = response();
    const execution = handleBotToolRequest(
      new MockRequest(
        JSON.stringify({
          groupName: "main",
          action: "run",
          bot: "coding",
          prompt: "inspect",
        }),
      ) as unknown as import("node:http").IncomingMessage,
      res as unknown as import("node:http").ServerResponse,
      "main",
      held,
    );
    try {
      await vi.waitFor(() => expect(childSignal).toBeDefined());
      let closed = false;
      const closing = held.close().then(() => {
        closed = true;
      });
      expect(childSignal?.aborted).toBe(true);
      await Promise.resolve();
      expect(closed).toBe(false);
      finishCleanup();
      await Promise.all([closing, execution]);
      expect(res.writeHead).toHaveBeenCalledWith(500, expect.any(Object));
      expect(acquireInferenceLock).not.toHaveBeenCalled();
    } finally {
      finishCleanup();
      await execution;
      await held.close();
    }
  });

  it("lock待機中のabortでは取得後のreleaseなしで失敗する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({ coding: { group: "main" } });
    acquireInferenceLock.mockRejectedValueOnce(
      new Error("inference resource lock aborted"),
    );

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
