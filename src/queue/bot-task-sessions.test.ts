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

  it("shares Task Session presentation helpers without delivery metadata", () => {
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
    expect(formatBotTaskSessionList([session])).not.toContain("channel");
  });

  it("keeps legacy channel storage inert while loading and resuming sessions", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    repository.db
      .prepare(
        `INSERT INTO bot_task_sessions
          (session_id,handle,group_name,bot_id,channel_id,source_key,created_at,last_used_at,preview)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "bot-task-legacy",
        "task-legacy",
        "main",
        "coding",
        "old-channel",
        null,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "Legacy task",
      );

    const loaded = repository
      .listBotTaskSessions("main", "coding")
      .find((session) => session.handle === "task-legacy");
    expect(loaded).toEqual({
      sessionId: "bot-task-legacy",
      handle: "task-legacy",
      groupName: "main",
      botId: "coding",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      preview: "Legacy task",
    });

    const resumed = repository.resumeBotTaskSessionAndEnqueue(
      "task-legacy",
      "main",
      "coding",
      "2026-01-02T00:00:00.000Z",
      request("resume", "legacy-resume"),
    );
    expect(resumed?.session).not.toHaveProperty("channelId");
    expect(resumed?.session).toEqual({
      ...loaded,
      lastUsedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(resumed?.enqueue.job).toMatchObject({
      sessionId: "bot-task-legacy",
      channelId: "channel-1",
      sequence: 0,
    });
    expect(
      repository.db
        .prepare("SELECT channel_id FROM bot_task_sessions WHERE session_id=?")
        .get("bot-task-legacy"),
    ).toEqual({ channel_id: "old-channel" });
  });

  it("persists metadata and isolates list/resume by group and Bot ownership", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    repository.createBotTaskSessionAndAdmission(input());
    repository.createBotTaskSessionAndAdmission(
      input({
        sessionId: "bot-task-2",
        handle: "task-two",
        botId: "research",
        preview: "Research the API",
      }),
    );
    repository.createBotTaskSessionAndAdmission(
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
    for (const [handle, groupName, botId] of [
      ["task-one", "main", "research"],
      ["task-one", "private", "coding"],
      ["missing", "main", "coding"],
    ] as const) {
      expect(
        repository.resumeBotTaskSessionAndEnqueue(
          handle,
          groupName,
          botId,
          "2026-01-02T00:00:00.000Z",
          request("unauthorized", "unauthorized"),
        ),
      ).toBeUndefined();
      expect(
        repository.resumeBotTaskSessionAndAdmission(
          handle,
          groupName,
          botId,
          "2026-01-02T00:00:00.000Z",
        ),
      ).toBeUndefined();
    }
    expect(repository.listBotTaskSessions("main", "coding")).toEqual([
      { ...input(), lastUsedAt: input().createdAt },
    ]);
    expect(
      repository.db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
    ).toEqual({ count: 3 });
    expect(repository.getIdempotencyRecord("unauthorized")).toBeUndefined();
  });

  it("uses the Task Session ID for queue ordering while delivery stays per request", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    const { session, enqueue: first } =
      repository.createBotTaskSessionAndEnqueue(input(), {
        channelId: "channel-1",
        groupName: "main",
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

  it("updates last-used without changing task identity", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    const first = repository.createBotTaskSessionAndAdmission(input());
    const resumed = repository.resumeBotTaskSessionAndAdmission(
      "task-one",
      "main",
      "coding",
      "2026-01-02T00:00:00.000Z",
    );

    expect(resumed?.session).toEqual({
      ...first.session,
      lastUsedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(repository.listBotTaskSessions("main", "coding")).toEqual([
      resumed?.session,
    ]);
    expect(first.admission.sequence).toBe(0);
    expect(resumed?.admission.sequence).toBe(1);
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
    expect(second.enqueue.job.id).toBe(first.enqueue.job.id);
    expect(repository.listBotTaskSessions("main", "coding")).toEqual([
      first.session,
    ]);
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
      repository.db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
    ).toEqual({ count: 0 });
    expect(repository.getIdempotencyRecord("run-failure")).toBeUndefined();
  });

  it("rolls back resume metadata when its enqueue fails", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    const first = repository.createBotTaskSessionAndEnqueue(
      input(),
      request("run", "run"),
    );
    failJobInsert(repository, "resume-failure");

    expect(() =>
      repository.resumeBotTaskSessionAndEnqueue(
        "task-one",
        "main",
        "coding",
        "2026-01-02T00:00:00.000Z",
        request("resume", "resume-failure"),
      ),
    ).toThrow("forced enqueue failure");

    expect(repository.listBotTaskSessions("main", "coding")).toEqual([
      first.session,
    ]);
    expect(repository.getIdempotencyRecord("resume-failure")).toBeUndefined();
    expect(
      repository.db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back session creation and last-used when direct admission fails", () => {
    const repository = new QueueRepository(openRuntimeDb(":memory:"));
    repositories.push(repository);
    const first = repository.createBotTaskSessionAndEnqueue(
      input(),
      request("run", "run"),
    );
    repository.db.exec(`
      CREATE TRIGGER fail_bot_task_admission
      BEFORE INSERT ON jobs
      WHEN json_extract(NEW.payload_json, '$.botTaskSessionAdmission') = 1
      BEGIN
        SELECT RAISE(ABORT, 'forced admission failure');
      END;
    `);

    expect(() =>
      repository.createBotTaskSessionAndAdmission(
        input({
          sessionId: "bot-task-failure",
          handle: "task-failure",
          sourceKey: "admission-failure",
        }),
      ),
    ).toThrow("forced admission failure");
    expect(repository.listBotTaskSessions("main", "coding")).toEqual([
      first.session,
    ]);
    expect(() =>
      repository.resumeBotTaskSessionAndAdmission(
        "task-one",
        "main",
        "coding",
        "2026-01-02T00:00:00.000Z",
      ),
    ).toThrow("forced admission failure");
    expect(repository.listBotTaskSessions("main", "coding")).toEqual([
      first.session,
    ]);
    expect(
      repository.db.prepare("SELECT COUNT(*) AS count FROM jobs").get(),
    ).toEqual({ count: 1 });
    expect(repository.get(first.enqueue.job.id)).toEqual(first.enqueue.job);
  });
});
