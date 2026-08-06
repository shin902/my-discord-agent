import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendInbox,
  claimInbox,
  deadLetterInbox,
  peekAllUnclaimedInbox,
  removeInboxById,
  renewInboxLease,
  updateInboxById,
  type QueueInput,
} from "./inbox.js";
import { QueueRepository } from "./repository.js";

let repository: QueueRepository;

function makeMessage(overrides: Partial<QueueInput> = {}): QueueInput {
  return {
    channelId: "channel-1",
    groupName: "default",
    sessionId: "session-1",
    messageId: "message-1",
    content: "hello",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  repository = new QueueRepository(":memory:");
});

afterEach(() => {
  repository.close();
});

describe("SQLite-backed inbox compatibility API", () => {
  it("appends a queued message with durable defaults", async () => {
    await appendInbox(makeMessage(), repository);

    const [job] = repository.list();
    expect(job).toMatchObject({
      channelId: "channel-1",
      groupName: "default",
      sessionId: "session-1",
      content: "hello",
      retries: 0,
      status: "queued",
      attempts: 0,
      maxAttempts: 10,
    });
    expect(job.id).toMatch(/^job-/);
    expect(job.enqueuedAt).toBeDefined();
  });

  it("peeks queued jobs in creation order and honors exclusions", async () => {
    await appendInbox(makeMessage({ content: "first" }), repository);
    await appendInbox(makeMessage({ content: "second" }), repository);
    await appendInbox(makeMessage({ content: "third" }), repository);
    const jobs = repository.list();

    expect((await peekAllUnclaimedInbox(new Set([jobs[0].id]), repository)).map((job) => job.content)).toEqual([
      "second",
      "third",
    ]);
  });

  it("claims, renews, and removes only the fenced running job", async () => {
    await appendInbox(makeMessage(), repository);
    const claimed = await claimInbox("worker-1", 1_000, new Set(), repository);
    const claimedJob = repository.get(claimed!.id)!;
    expect(claimedJob.status).toBe("running");
    expect(claimedJob.workerId).toBe("worker-1");

    await renewInboxLease(claimedJob.id, claimedJob.fencingToken, 2_000, repository);
    await removeInboxById(claimedJob.id, claimedJob.fencingToken, repository);

    expect(repository.get(claimedJob.id)?.status).toBe("completed");
    expect(await peekAllUnclaimedInbox(new Set(), repository)).toEqual([]);
  });

  it("does not enqueue a completed idempotency key twice", async () => {
    const input = makeMessage({ idempotencyKey: "rss-dispatch-1" });
    await appendInbox(input, repository);
    const first = repository.list()[0];
    const claimed = await claimInbox("worker-1", 1_000, new Set(), repository);
    const claimedJob = repository.get(claimed!.id)!;
    await removeInboxById(first.id, claimedJob.fencingToken, repository);

    await appendInbox(input, repository);

    expect(repository.list()).toHaveLength(1);
    expect(repository.getIdempotencyRecord("rss-dispatch-1")).toMatchObject({
      jobId: first.id,
      status: "completed",
    });
  });
  it("updates a running job through retry state and retains its payload", async () => {
    await appendInbox(makeMessage(), repository);
    const claimed = await claimInbox("worker-1", 1_000, new Set(), repository);
    const claimedJob = repository.get(claimed!.id)!;

    await updateInboxById(claimedJob.id, { content: "updated", retries: 1, lastError: "temporary" }, claimedJob.fencingToken, repository);

    expect(repository.get(claimed!.id)).toMatchObject({
      content: "updated",
      retries: 1,
      status: "retry_wait",
      lastError: "temporary",
    });
  });
  it("dead-letters a claimed job and makes it invisible to peek", async () => {
    await appendInbox(makeMessage(), repository);
    const claimed = await claimInbox("worker-1", 1_000, new Set(), repository);
    const claimedJob = repository.get(claimed!.id)!;

    await deadLetterInbox(claimedJob.id, "invalid", "bad payload", claimedJob.fencingToken, repository);

    expect(repository.get(claimed!.id)?.status).toBe("dead_letter");
    expect(await peekAllUnclaimedInbox(new Set(), repository)).toEqual([]);
    expect(repository.db.prepare("SELECT reason,error FROM dead_letters WHERE job_id=?").get(claimed!.id)).toEqual({
      reason: "invalid",
      error: "bad payload",
    });
  });
});
