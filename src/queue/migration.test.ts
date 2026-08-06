import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateLegacyQueue } from "./migration.js";
import { QueueRepository, openRuntimeDb } from "./repository.js";

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function makePaths(content: string): Promise<{ inbox: string; dead: string; archive: string }> {
  const dir = await mkdtemp(join(tmpdir(), "queue-migration-test-"));
  tempDirs.push(dir);
  const inbox = join(dir, "inbox.jsonl");
  const dead = join(dir, "dead-letter.jsonl");
  await writeFile(inbox, content, "utf8");
  return { inbox, dead, archive: join(dir, "archive") };
}

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "legacy-1",
    channelId: "channel",
    groupName: "group",
    sessionId: "session",
    content: "content",
    timestamp: "2026-08-01T00:00:00.000Z",
    retries: 0,
    ...overrides,
  };
}

describe("migrateLegacyQueue", () => {
  it("classifies malformed optional fields as dead letters without aborting", async () => {
    const paths = await makePaths(`${JSON.stringify(message({ retries: "not-a-number" }))}\n${JSON.stringify(message({ id: "valid" }))}\n`);
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const result = await migrateLegacyQueue(repo, { inboxPath: paths.inbox, deadLetterPath: paths.dead, archiveDir: paths.archive });
      expect(result.malformed).toBe(1);
      expect(result.migrated).toBe(1);
      expect(repo.list()).toHaveLength(1);
      expect(repo.db.prepare("SELECT reason FROM dead_letters").all()).toEqual([{ reason: "invalid_inbox_row" }]);
    } finally {
      repo.close();
    }
  });

  it("commits rows and digest marker atomically so a failed migration can be retried", async () => {
    const paths = await makePaths(`${JSON.stringify(message())}\n`);
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      repo.db.exec("CREATE TEMP TRIGGER fail_migration BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END");
      await expect(migrateLegacyQueue(repo, { inboxPath: paths.inbox, deadLetterPath: paths.dead, archiveDir: paths.archive })).rejects.toThrow("forced migration failure");
      const archives = await readdir(paths.archive);
      expect(archives).toHaveLength(1);
      expect(await readFile(join(paths.archive, archives[0]))).toEqual(Buffer.from(`${JSON.stringify(message())}\n`));
      expect(repo.list()).toEqual([]);
      expect(repo.db.prepare("SELECT COUNT(*) AS count FROM schema_meta WHERE key LIKE 'legacy_migration:%'").get()).toEqual({ count: 0 });
      repo.db.exec("DROP TRIGGER fail_migration");
      const result = await migrateLegacyQueue(repo, { inboxPath: paths.inbox, deadLetterPath: paths.dead, archiveDir: paths.archive });
      expect(result.migrated).toBe(1);
      expect(result.backupPaths).toHaveLength(1);
      expect((await migrateLegacyQueue(repo, { inboxPath: paths.inbox, deadLetterPath: paths.dead, archiveDir: paths.archive })).migrated).toBe(0);
    } finally {
      repo.close();
    }
  });
});
