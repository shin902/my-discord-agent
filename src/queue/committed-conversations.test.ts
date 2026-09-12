import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { expectDefined } from "../test-utils.js";
import { QueueRepository } from "./repository.js";

const repositories: QueueRepository[] = [];
function repository(): QueueRepository {
  const repo = new QueueRepository(":memory:");
  repositories.push(repo);
  return repo;
}
afterEach(() => {
  for (const repo of repositories.splice(0)) repo.close();
});
function claim(repo: QueueRepository, group = "group") {
  const { job } = repo.enqueue(
    {
      groupName: group,
      channelId: "channel",
      sessionId: "session",
      content: "private input",
      timestamp: new Date().toISOString(),
    },
    { idempotencyKey: `source-${randomUUID()}` },
  );
  const claimed = expectDefined(repo.claim("worker"));
  expect(claimed.job.id).toBe(job.id);
  return claimed;
}
const conversation = { userEntryId: 10, assistantEntryId: 20 };

describe("committed conversation references", () => {
  it.each([
    "committed_conversations",
    "deliveries",
  ])("rolls back adoption, job success, idempotency and delivery together if %s insertion fails", (table) => {
    const repo = repository();
    const { job, fencingToken } = claim(repo);
    repo.db.exec(
      `CREATE TRIGGER reject_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`,
    );
    expect(() =>
      repo.commitResult(job.id, fencingToken, "private answer", {
        conversation,
      }),
    ).toThrow("injected failure");
    expect(repo.get(job.id)).toMatchObject({
      status: job.status,
      succeeded: false,
    });
    expect([...repo.readCommittedConversations("group")]).toEqual([]);
    expect(repo.listDeliveries()).toEqual([]);
    expect(
      repo.db.prepare("SELECT status FROM idempotency_keys").get(),
    ).toEqual({ status: "active" });
    repo.db.exec("DROP TRIGGER reject_insert");
    repo.commitResult(job.id, fencingToken, "private answer", { conversation });
    expect(repo.get(job.id)).toMatchObject({
      status: "completed",
      succeeded: true,
    });
    expect([...repo.readCommittedConversations("group")]).toEqual([
      conversation,
    ]);
    expect(repo.listDeliveries()).toHaveLength(1);
    expect(
      repo.db.prepare("SELECT status FROM idempotency_keys").get(),
    ).toEqual({ status: "completed" });
    const row = repo.db.prepare("SELECT * FROM committed_conversations").get();
    expect(row).toEqual({
      id: 1,
      turn_id: job.id,
      group_name: "group",
      user_entry_id: 10,
      assistant_entry_id: 20,
      committed_at: expect.any(String),
    });
    expect(JSON.stringify(row)).not.toContain("private");
    expect(() =>
      repo.commitResult(job.id, fencingToken, "again", { conversation }),
    ).toThrow(/stale fencing/);
    expect([...repo.readCommittedConversations("group")]).toEqual([
      conversation,
    ]);
  });

  it("pages references in commit order across groups without skipping or duplicating a page boundary", () => {
    const repo = repository();
    for (let index = 0; index < 205; index++) {
      const { job, fencingToken } = claim(repo);
      repo.commitResult(job.id, fencingToken, "answer", {
        conversation: {
          userEntryId: index * 2 + 1,
          assistantEntryId: index * 2 + 2,
        },
        suppressDelivery: true,
      });
    }
    const other = claim(repo, "other");
    repo.commitResult(other.job.id, other.fencingToken, "answer", {
      conversation,
      suppressDelivery: true,
    });
    const rows = [...repo.readCommittedConversations("group")];
    expect(rows).toEqual(
      Array.from({ length: 205 }, (_, index) => ({
        userEntryId: index * 2 + 1,
        assistantEntryId: index * 2 + 2,
      })),
    );
    expect([...repo.readCommittedConversations("other")]).toEqual([
      conversation,
    ]);
    expect([...repo.readCommittedConversations("missing")]).toEqual([]);
  });

  it("upgrades v6 without inferring old results and preserves references on repeated initialization", () => {
    const repo = repository();
    const old = claim(repo);
    repo.commitResult(old.job.id, old.fencingToken, "old success");
    repo.db.exec(
      "DROP TABLE committed_conversations; UPDATE schema_meta SET value='6' WHERE key='schema_version';",
    );
    const reopened = new QueueRepository(repo.db);
    expect([...reopened.readCommittedConversations("group")]).toEqual([]);
    const current = claim(reopened);
    reopened.commitResult(current.job.id, current.fencingToken, "new success", {
      conversation,
    });
    const again = new QueueRepository(repo.db);
    expect([...again.readCommittedConversations("group")]).toEqual([
      conversation,
    ]);
    expect(repo.db.pragma("foreign_key_check")).toEqual([]);
    expect(repo.db.pragma("foreign_key_list(committed_conversations)")).toEqual(
      [],
    );
  });
});
