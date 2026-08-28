import { afterEach, describe, expect, it } from "vitest";
import {
  formatBotTaskSessionList,
  generateBotTaskSessionHandle,
  generateBotTaskSessionId,
  previewBotTaskPrompt,
} from "./bot-task-sessions.js";
import {
  type CreateBotTaskSessionInput,
  openRuntimeDb,
  QueueRepository,
} from "./repository.js";

function input(
  overrides: Partial<CreateBotTaskSessionInput> = {},
): CreateBotTaskSessionInput {
  return {
    sessionId: "bot-task-1",
    handle: "task-one",
    groupName: "main",
    botId: "coding",
    channelId: "channel-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    preview: "Fix the parser",
    ...overrides,
  };
}

describe("Bot task sessions", () => {
  const repositories: QueueRepository[] = [];

  function request(content: string, idempotencyKey: string) {
    return {
      channelId: "channel-1",
      groupName: "main",
      content,
      timestamp: "2026-01-01T00:00:00.000Z",
      idempotencyKey,
      botId: "coding",
    };
  }

  function failJobInsert(repository: QueueRepository, key: string): void {
    repository.db.exec(`
      CREATE TRIGGER fail_bot_task_enqueue
      BEFORE INSERT ON jobs
      WHEN NEW.idempotency_key = '${key}'
      BEGIN
        SELECT RAISE(ABORT, 'forced enqueue failure');
      END;
    `);
  }

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
  });

  it("shares Task Session presentation helpers while keeping channel output explicit", () => {
    const session = {
      ...input(),
      lastUsedAt: input().createdAt,
    };

    expect(generateBotTaskSessionId()).toMatch(/^bot-task-[0-9a-f-]{36}$/);
    expect(generateBotTaskSessionHandle()).toMatch(/^task-[0-9a-f]{12}$/);
    expect(previewBotTaskPrompt("  first\nsecond   third  ")).toBe(
      "first second third",
    );
    expect(previewBotTaskPrompt("x".repeat(101))).toBe(`${"x".repeat(97)}...`);

    expect(formatBotTaskSessionList([session])).toBe(
      "Task Session一覧（1件）:\n- task-one | coding | created: 2026-01-01T00:00:00.000Z | last-used: 2026-01-01T00:00:00.000Z | Fix the parser",
    );
    expect(
      formatBotTaskSessionList([session], { includeChannelId: true }),
    ).toContain("Fix the parser (channel: channel-1)");
  });

  it("persists metadata and isolates list/find by group and Bot ownership", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    repository.createBotTaskSession(input());
    repository.createBotTaskSession(
      input({
        sessionId: "bot-task-2",
        handle: "task-two",
        botId: "research",
        preview: "Research the API",
      }),
    );
    repository.createBotTaskSession(
      input({
        sessionId: "bot-task-3",
        handle: "task-three",
        groupName: "private",
        preview: "Private task",
      }),
    );

    expect(repository.listBotTaskSessions("main", "coding")).toEqual([
      expect.objectContaining({
        sessionId: "bot-task-1",
        handle: "task-one",
        preview: "Fix the parser",
      }),
    ]);
    expect(repository.listBotTaskSessions("main", "research")).toHaveLength(1);
    expect(repository.listBotTaskSessions("private", "coding")).toHaveLength(1);
    expect(
      repository.findBotTaskSession("task-one", "main", "research"),
    ).toBeUndefined();
    expect(
      repository.findBotTaskSession("task-one", "main", "coding"),
    ).toMatchObject({ sessionId: "bot-task-1" });
  });

  it("uses the Task Session ID for queue ordering while delivery stays per request", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    const session = repository.createBotTaskSession(input());
    const first = repository.enqueue({
      channelId: "channel-1",
      groupName: "main",
      sessionId: session.sessionId,
      content: "first",
      timestamp: "2026-01-01T00:00:00.000Z",
      botId: "coding",
    });
    const second = repository.enqueue({
      channelId: "thread-1",
      groupName: "main",
      sessionId: session.sessionId,
      content: "second",
      timestamp: "2026-01-02T00:00:00.000Z",
      botId: "coding",
    });

    expect(first.job.sequence).toBe(0);
    expect(second.job.sequence).toBe(1);
    expect(first.job.sessionId).toBe(second.job.sessionId);
    expect(first.job.channelId).not.toBe(second.job.channelId);
  });

  it("updates last-used and delivery channel without changing task identity", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    repository.createBotTaskSession(input());
    repository.touchBotTaskSession(
      "bot-task-1",
      "thread-1",
      "2026-01-02T00:00:00.000Z",
    );

    expect(
      repository.findBotTaskSession("task-one", "main", "coding"),
    ).toMatchObject({
      sessionId: "bot-task-1",
      channelId: "thread-1",
      lastUsedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("preserves source-key and idempotency behavior across retries", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    const sourceKey = "discord-interaction:retry";
    const first = repository.createBotTaskSessionAndEnqueue(
      input({ sourceKey }),
      request("run", "discord-interaction:retry"),
    );
    const second = repository.createBotTaskSessionAndEnqueue(
      input({
        sessionId: "bot-task-retry-ignored",
        handle: "retry-ignored",
        sourceKey,
      }),
      request("run", "discord-interaction:retry"),
    );

    expect(second.session).toEqual(first.session);
    expect(second.enqueue.inserted).toBe(false);
    expect(
      repository.db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back a new session when its enqueue fails", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    failJobInsert(repository, "run-failure");

    expect(() =>
      repository.createBotTaskSessionAndEnqueue(
        input({ sourceKey: "discord-interaction:run-failure" }),
        request("run", "run-failure"),
      ),
    ).toThrow("forced enqueue failure");

    expect(repository.listBotTaskSessions("main", "coding")).toEqual([]);
    expect(
      repository.findBotTaskSession("task-one", "main", "coding"),
    ).toBeUndefined();
  });

  it("rolls back resume metadata when its enqueue fails", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    repository.createBotTaskSession(input());
    failJobInsert(repository, "resume-failure");

    expect(() =>
      repository.resumeBotTaskSessionAndEnqueue(
        "task-one",
        "main",
        "coding",
        "thread-1",
        "2026-01-02T00:00:00.000Z",
        request("resume", "resume-failure"),
      ),
    ).toThrow("forced enqueue failure");

    expect(
      repository.findBotTaskSession("task-one", "main", "coding"),
    ).toMatchObject({
      sessionId: "bot-task-1",
      channelId: "channel-1",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
