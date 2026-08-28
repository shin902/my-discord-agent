import { afterEach, describe, expect, it } from "vitest";
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
