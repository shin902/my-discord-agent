import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { sendMessage, findGroupByName, loadBotRegistry, repository } =
  vi.hoisted(() => ({
    sendMessage: vi.fn(),
    findGroupByName: vi.fn(),
    loadBotRegistry: vi.fn(),
    repository: {
      createBotTaskSession: vi.fn(),
      findBotTaskSession: vi.fn(),
      touchBotTaskSession: vi.fn(),
      listBotTaskSessions: vi.fn(),
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

function invoke(req: MockRequest, res: ReturnType<typeof response>) {
  return handleBotToolRequest(
    req as unknown as import("node:http").IncomingMessage,
    res as unknown as import("node:http").ServerResponse,
  );
}

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "bot-task-1",
    handle: "task-abc123",
    groupName: "main",
    botId: "coding",
    channelId: "agent:main",
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
      coding: { group: "main", instructions: "code" },
    });
    repository.createBotTaskSession.mockReturnValue(session());
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

    expect(repository.createBotTaskSession).toHaveBeenCalledWith(
      expect.objectContaining({ botId: "coding", preview: "inspect" }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "main",
      "bot-task-1",
      "inspect",
      expect.objectContaining({ enableBotTool: false }),
    );
    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({
      content: "調査結果",
      action: "run",
      botId: "coding",
      session: "task-abc123",
    });
  });

  it("resumeは同じ所有者のTask Sessionだけを使い同期実行する", async () => {
    findGroupByName.mockResolvedValue({ name: "main" });
    loadBotRegistry.mockResolvedValue({
      coding: { group: "main", instructions: "code" },
    });
    repository.findBotTaskSession.mockReturnValue(session());
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

    expect(repository.touchBotTaskSession).toHaveBeenCalledWith(
      "bot-task-1",
      "agent:main",
      expect.any(String),
    );
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
    expect(JSON.parse(res.end.mock.calls[0][0]).content).toContain(
      "task-abc123",
    );
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
