import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeQueue } from "./migration.js";
import { openRuntimeDb, QueueRepository } from "./repository.js";

let tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

describe("normal runtime startup", () => {
  it("recovers admissions and expired leases in order", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const admissions = vi.spyOn(repo, "recoverBotTaskSessionAdmissions");
      const expired = vi.spyOn(repo, "recoverExpired");
      await initializeQueue(repo);
      expect(admissions).toHaveBeenCalledOnce();
      expect(expired).toHaveBeenCalledOnce();
      expect(admissions.mock.invocationCallOrder[0]).toBeLessThan(
        expired.mock.invocationCallOrder[0],
      );
    } finally {
      repo.close();
    }
  });

  it("rejects the reserved main Bot ID before startup recovery", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      repo.db
        .prepare(
          `INSERT INTO bot_task_sessions
            (session_id,handle,group_name,bot_id,channel_id,created_at,last_used_at,preview)
           VALUES ('legacy-task','legacy','group','main','','now','now','legacy')`,
        )
        .run();
      const admissions = vi.spyOn(repo, "recoverBotTaskSessionAdmissions");
      const expired = vi.spyOn(repo, "recoverExpired");

      await expect(initializeQueue(repo)).rejects.toThrow(
        "Bot main の保存状態が不正です: main はMain専用の予約IDです (group/legacy-task)",
      );
      expect(admissions).not.toHaveBeenCalled();
      expect(expired).not.toHaveBeenCalled();
    } finally {
      repo.close();
    }
  });

  it("does not read or modify legacy queue JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "queue-startup-test-"));
    tempDirs.push(dir);
    const inbox = join(dir, "inbox.jsonl");
    const dead = join(dir, "dead-letter.jsonl");
    await writeFile(inbox, '{"id":"legacy-1"}\n');
    await writeFile(dead, '{"reason":"legacy"}\n');
    const repo = new QueueRepository(
      openRuntimeDb(join(dir, "runtime.sqlite")),
    );
    try {
      await initializeQueue(repo);
      expect(
        repo.db.prepare("SELECT count(*) AS count FROM jobs").get(),
      ).toEqual({ count: 0 });
      expect(
        repo.db.prepare("SELECT count(*) AS count FROM dead_letters").get(),
      ).toEqual({ count: 0 });
      expect(await readFile(inbox, "utf8")).toBe('{"id":"legacy-1"}\n');
      expect(await readFile(dead, "utf8")).toBe('{"reason":"legacy"}\n');
      expect(
        (await readdir(dir)).filter(
          (name) => name === "archive" || name.endsWith(".bak"),
        ),
      ).toEqual([]);
    } finally {
      repo.close();
    }
  });

  it("rejects unconverted legacy source rows before claiming any job", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const job = repo.enqueue({
        channelId: "channel",
        groupName: "group",
        sessionId: "session",
        content: "mail",
        timestamp: new Date().toISOString(),
      }).job;
      repo.db
        .prepare(
          "UPDATE jobs SET payload_json=json_set(payload_json,'$.mailEmailId','email-1') WHERE id=?",
        )
        .run(job.id);
      await expect(initializeQueue(repo)).rejects.toThrow(
        /conversion is required/,
      );
    } finally {
      repo.close();
    }
  });
});
