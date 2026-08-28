import { afterEach, describe, expect, it } from "vitest";
import { openRuntimeDb, QueueRepository } from "./repository.js";
import { withBotTaskSessionLease } from "./session-lease.js";

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

  it("releases after errors and recovers an expired lease", async () => {
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
    const recovered = repository.tryAcquireBotTaskSessionLease(
      "session-2",
      "owner-2",
      1,
      new Date(Date.now() + 2),
    );
    expect(recovered).toMatchObject({ ownerId: "owner-2", fencingToken: 2 });
    repository.releaseBotTaskSessionLease(first as NonNullable<typeof first>);
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
