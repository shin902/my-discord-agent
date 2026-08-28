import { afterEach, describe, expect, it } from "vitest";
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

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
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
});
