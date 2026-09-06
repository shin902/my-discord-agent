import { afterEach, describe, expect, it, vi } from "vitest";
import { openRuntimeDb, QueueRepository } from "./repository.js";
import { withBotTaskSessionAdmission } from "./session-admission.js";

function createRepository(): QueueRepository {
  return new QueueRepository(openRuntimeDb(":memory:"));
}

describe("Bot Task Session admission", () => {
  const repositories: QueueRepository[] = [];

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
  });

  it("direct admission waits behind an earlier queued invocation in the same database", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-ordered",
      handle: "task-ordered",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "queued",
    });
    const queued = repository.enqueue({
      channelId: "channel",
      groupName: "main",
      sessionId: session.sessionId,
      content: "queued",
      timestamp: new Date().toISOString(),
      botId: "coding",
    });
    const direct = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    expect(direct).toBeDefined();
    if (!direct) throw new Error("direct admission was not created");
    let directStarted = false;
    const directRun = withBotTaskSessionAdmission(
      repository,
      direct.admission,
      async () => {
        directStarted = true;
        return "direct";
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(directStarted).toBe(false);

    const claimed = repository.claim("poller");
    expect(claimed?.job.id).toBe(queued.job.id);
    if (!claimed) throw new Error("queued job was not claimed");
    repository.markRunning(queued.job.id, claimed.fencingToken);
    repository.commitResult(queued.job.id, claimed.fencingToken, "", {
      empty: true,
    });
    await expect(directRun).resolves.toBe("direct");
    expect(directStarted).toBe(true);
  });

  it("fail-fast admissionは先行処理をterminal cancellationにして後続を塞がない", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-fail-fast",
      handle: "task-fail-fast",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "queued",
    });
    const first = repository.enqueue({
      channelId: "channel",
      groupName: "main",
      sessionId: session.sessionId,
      content: "queued",
      timestamp: new Date().toISOString(),
      botId: "coding",
    });
    const direct = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    expect(direct).toBeDefined();
    if (!direct) throw new Error("direct admission was not created");
    const later = repository.enqueue({
      channelId: "channel",
      groupName: "main",
      sessionId: session.sessionId,
      content: "later",
      timestamp: new Date().toISOString(),
      botId: "coding",
    });

    expect(repository.tryAdmitBotTaskSessionAdmission(direct.admission)).toBe(
      "blocked",
    );
    const blockedClaim = repository.claim("poller");
    expect(blockedClaim?.job.id).toBe(first.job.id);
    if (!blockedClaim) throw new Error("earlier job was not claimed");
    repository.markRunning(first.job.id, blockedClaim.fencingToken);
    repository.commitResult(first.job.id, blockedClaim.fencingToken, "", {
      empty: true,
    });
    expect(repository.claim("poller")?.job.id).toBe(later.job.id);
  });

  it("immediate admission succeeds when no predecessor blocks it", () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-immediate",
      handle: "task-immediate",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const direct = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    expect(direct).toBeDefined();
    if (!direct) throw new Error("direct admission was not created");
    expect(repository.tryAdmitBotTaskSessionAdmission(direct.admission)).toBe(
      "admitted",
    );
    repository.completeBotTaskSessionAdmission(direct.admission);
  });

  it("two direct admissions execute in acceptance order using the admission ledger", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-direct-direct",
      handle: "task-direct-direct",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const first = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    const second = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("direct admission was not created");

    let releaseFirst!: () => void;
    let firstStarted = false;
    const firstRun = withBotTaskSessionAdmission(
      repository,
      first.admission,
      async () => {
        firstStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return "first";
      },
    );
    await vi.waitFor(() => expect(firstStarted).toBe(true));

    let secondStarted = false;
    const secondRun = withBotTaskSessionAdmission(
      repository,
      second.admission,
      async () => {
        secondStarted = true;
        return "second";
      },
    );
    await Promise.resolve();
    expect(secondStarted).toBe(false);

    releaseFirst();
    await expect(firstRun).resolves.toBe("first");
    await expect(secondRun).resolves.toBe("second");
    expect(secondStarted).toBe(true);
  });

  it("different sessions can execute concurrently through the admission ledger", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const firstSession = repository.createBotTaskSession({
      sessionId: "session-parallel-first",
      handle: "task-parallel-first",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "first",
    });
    const secondSession = repository.createBotTaskSession({
      sessionId: "session-parallel-second",
      handle: "task-parallel-second",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "second",
    });
    const first = repository.resumeBotTaskSessionAndAdmission(
      firstSession.handle,
      firstSession.groupName,
      firstSession.botId,
      new Date().toISOString(),
    );
    const second = repository.resumeBotTaskSessionAndAdmission(
      secondSession.handle,
      secondSession.groupName,
      secondSession.botId,
      new Date().toISOString(),
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("direct admission was not created");

    let releaseFirst!: () => void;
    let firstStarted = false;
    const firstRun = withBotTaskSessionAdmission(
      repository,
      first.admission,
      async () => {
        firstStarted = true;
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
    );
    await vi.waitFor(() => expect(firstStarted).toBe(true));

    let secondStarted = false;
    const secondRun = withBotTaskSessionAdmission(
      repository,
      second.admission,
      async () => {
        secondStarted = true;
      },
    );
    await vi.waitFor(() => expect(secondStarted).toBe(true));

    releaseFirst();
    await Promise.all([firstRun, secondRun]);
  });

  it("failed direct admission settles its ticket so a successor can execute", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-direct-failure",
      handle: "task-direct-failure",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const first = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    const second = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (!first || !second) throw new Error("direct admission was not created");

    await expect(
      withBotTaskSessionAdmission(repository, first.admission, async () => {
        throw new Error("direct failed");
      }),
    ).rejects.toThrow("direct failed");
    expect(repository.get(first.admission.jobId)?.status).toBe("completed");

    await expect(
      withBotTaskSessionAdmission(
        repository,
        second.admission,
        async () => "successor",
      ),
    ).resolves.toBe("successor");
  });

  it("aborted direct admission settles its waiting ticket and unblocks later queue work", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-direct-abort",
      handle: "task-direct-abort",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "queued",
    });
    const first = repository.enqueue({
      channelId: "channel",
      groupName: "main",
      sessionId: session.sessionId,
      content: "first",
      timestamp: new Date().toISOString(),
      botId: "coding",
    });
    const direct = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    expect(direct).toBeDefined();
    if (!direct) throw new Error("direct admission was not created");
    const later = repository.enqueue({
      channelId: "channel",
      groupName: session.groupName,
      sessionId: session.sessionId,
      content: "later",
      timestamp: new Date().toISOString(),
      botId: session.botId,
    });

    const controller = new AbortController();
    const directRun = withBotTaskSessionAdmission(
      repository,
      direct.admission,
      async () => "unexpected",
      controller.signal,
    );
    controller.abort();
    await expect(directRun).rejects.toThrow("admission aborted");
    expect(repository.get(direct.admission.jobId)).toMatchObject({
      status: "dead_letter",
      terminalReason: "cancelled",
    });

    const claimed = repository.claim("poller");
    expect(claimed?.job.id).toBe(first.job.id);
    if (!claimed) throw new Error("first queued job was not claimed");
    repository.markRunning(first.job.id, claimed.fencingToken);
    repository.commitResult(first.job.id, claimed.fencingToken, "", {
      empty: true,
    });
    expect(repository.claim("poller")?.job.id).toBe(later.job.id);
  });

  it("a queued retry blocks successors until it becomes terminal", () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-queue-retry",
      handle: "task-queue-retry",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "queued",
    });
    const first = repository.enqueue(
      {
        channelId: "channel",
        groupName: session.groupName,
        sessionId: session.sessionId,
        content: "first",
        timestamp: new Date().toISOString(),
        botId: session.botId,
      },
      { maxAttempts: 2 },
    );
    const later = repository.enqueue({
      channelId: "channel",
      groupName: session.groupName,
      sessionId: session.sessionId,
      content: "later",
      timestamp: new Date().toISOString(),
      botId: session.botId,
    });

    const claimed = repository.claim("poller");
    expect(claimed?.job.id).toBe(first.job.id);
    if (!claimed) throw new Error("first queued job was not claimed");
    repository.failAttempt(
      first.job.id,
      new Error("temporary"),
      claimed.fencingToken,
    );
    expect(repository.get(first.job.id)?.status).toBe("retry_wait");
    expect(repository.claim("poller")?.job.id).toBeUndefined();

    const retryDue = repository.get(first.job.id)?.nextAttemptAt;
    expect(retryDue).toBeDefined();
    if (!retryDue) throw new Error("retry time was not recorded");
    const retried = repository.claim("poller", 60_000, new Date(retryDue));
    expect(retried?.job.id).toBe(first.job.id);
    if (!retried) throw new Error("retry was not claimable");
    repository.deadLetter(
      first.job.id,
      retried.fencingToken,
      "non_retryable",
      "terminal failure",
    );
    expect(repository.claim("poller")?.job.id).toBe(later.job.id);
  });

  it("a later queued invocation cannot overtake an admitted direct invocation", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-direct-first",
      handle: "task-direct-first",
      groupName: "main",
      botId: "coding",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const direct = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      new Date().toISOString(),
    );
    expect(direct).toBeDefined();
    if (!direct) throw new Error("direct admission was not created");
    expect(repository.admitBotTaskSessionAdmission(direct.admission)).toBe(
      true,
    );
    const queued = repository.enqueue({
      channelId: "channel",
      groupName: "main",
      sessionId: session.sessionId,
      content: "queued",
      timestamp: new Date().toISOString(),
      botId: "coding",
    });
    expect(repository.claim("poller")).toBeUndefined();
    repository.completeBotTaskSessionAdmission(direct.admission);
    expect(repository.claim("poller")?.job.id).toBe(queued.job.id);
  });
});
