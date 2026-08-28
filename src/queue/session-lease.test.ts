import { afterEach, describe, expect, it, vi } from "vitest";
import { openRuntimeDb, QueueRepository } from "./repository.js";
import {
  withBotTaskSessionAdmission,
  withBotTaskSessionLease,
} from "./session-lease.js";

function createRepository(): QueueRepository {
  return new QueueRepository(openRuntimeDb(":memory:"));
}

describe("Bot Task Session lease", () => {
  const repositories: QueueRepository[] = [];

  afterEach(() => {
    for (const repository of repositories.splice(0)) repository.close();
  });

  it("serializes direct executions for one session while allowing different sessions", async () => {
    const repository = createRepository();
    repositories.push(repository);
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      void withBotTaskSessionLease(repository, "session-1", async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
        return "first";
      });
    });
    await firstEntered;

    let secondStarted = false;
    const second = withBotTaskSessionLease(
      repository,
      "session-1",
      async () => {
        secondStarted = true;
        return "second";
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(secondStarted).toBe(false);

    let otherStarted = false;
    const other = withBotTaskSessionLease(repository, "session-2", async () => {
      otherStarted = true;
      return "other";
    });
    await expect(other).resolves.toBe("other");
    expect(otherStarted).toBe(true);

    releaseFirst();
    await expect(second).resolves.toBe("second");
  });

  it("releases after errors and does not take over an active execution", async () => {
    const repository = createRepository();
    repositories.push(repository);
    await expect(
      withBotTaskSessionLease(repository, "session-1", async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow("failed");
    await expect(
      withBotTaskSessionLease(repository, "session-1", async () => "next"),
    ).resolves.toBe("next");

    const first = repository.tryAcquireBotTaskSessionLease(
      "session-2",
      "owner-1",
      1,
    );
    expect(first).toBeDefined();
    const blocked = repository.tryAcquireBotTaskSessionLease(
      "session-2",
      "owner-2",
      1,
      new Date(Date.now() + 2),
    );
    expect(blocked).toBeUndefined();
    repository.releaseBotTaskSessionLease(first as NonNullable<typeof first>);
    const recovered = repository.tryAcquireBotTaskSessionLease(
      "session-2",
      "owner-2",
      1,
    );
    expect(recovered).toMatchObject({ ownerId: "owner-2", fencingToken: 1 });
    expect(
      repository.renewBotTaskSessionLease(
        recovered as NonNullable<typeof recovered>,
        60_000,
      ),
    ).toBe(true);
    repository.releaseBotTaskSessionLease(
      recovered as NonNullable<typeof recovered>,
    );
  });

  it("direct admission waits behind an earlier queued invocation in the same database", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-ordered",
      handle: "task-ordered",
      groupName: "main",
      botId: "coding",
      channelId: "channel",
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
      "agent:main",
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
    repository.complete(queued.job.id, claimed.fencingToken);
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
      channelId: "channel",
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
      "agent:main",
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
    repository.complete(first.job.id, blockedClaim.fencingToken);
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
      channelId: "channel",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const direct = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      "agent:main",
      new Date().toISOString(),
    );
    expect(direct).toBeDefined();
    if (!direct) throw new Error("direct admission was not created");
    expect(repository.tryAdmitBotTaskSessionAdmission(direct.admission)).toBe(
      "admitted",
    );
    repository.completeBotTaskSessionAdmission(direct.admission);
  });

  it("two direct admissions execute in acceptance order without using the session lease", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-direct-direct",
      handle: "task-direct-direct",
      groupName: "main",
      botId: "coding",
      channelId: "channel",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const first = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      "agent:main",
      new Date().toISOString(),
    );
    const second = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      "agent:main",
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

  it("failed direct admission settles its ticket so a successor can execute", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const session = repository.createBotTaskSession({
      sessionId: "session-direct-failure",
      handle: "task-direct-failure",
      groupName: "main",
      botId: "coding",
      channelId: "channel",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const first = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      "agent:main",
      new Date().toISOString(),
    );
    const second = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      "agent:main",
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
      channelId: "channel",
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
      "agent:main",
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
    await expect(directRun).rejects.toThrow("lease aborted");
    expect(repository.get(direct.admission.jobId)).toMatchObject({
      status: "dead_letter",
      terminalReason: "cancelled",
    });

    const claimed = repository.claim("poller");
    expect(claimed?.job.id).toBe(first.job.id);
    if (!claimed) throw new Error("first queued job was not claimed");
    repository.complete(first.job.id, claimed.fencingToken);
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
      channelId: "channel",
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
      channelId: "channel",
      createdAt: new Date().toISOString(),
      preview: "direct",
    });
    const direct = repository.resumeBotTaskSessionAndAdmission(
      session.handle,
      session.groupName,
      session.botId,
      "agent:main",
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

  it("aborting while waiting does not start the second execution", async () => {
    const repository = createRepository();
    repositories.push(repository);
    const first = repository.tryAcquireBotTaskSessionLease(
      "session-1",
      "owner-1",
      60_000,
    );
    expect(first).toBeDefined();
    const controller = new AbortController();
    const second = withBotTaskSessionLease(
      repository,
      "session-1",
      async () => "unexpected",
      controller.signal,
    );
    controller.abort();
    await expect(second).rejects.toThrow("lease aborted");
    repository.releaseBotTaskSessionLease(first as NonNullable<typeof first>);
  });
});
