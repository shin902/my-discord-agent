import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { QueueRepository, openRuntimeDb } from "./repository.js";
import { planRetention, pruneRetention } from "./retention.js";

const payload = { channelId: "c", groupName: "g", sessionId: "s", content: "hello", timestamp: new Date().toISOString() };

describe("runtime retention", () => {
  it("keeps active and ambiguous rows in dry-run and prune", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "retention-"));
    try {
      const active = repo.enqueue(payload, { idempotencyKey: "active" }).job;
      const claim = repo.claim("worker", 60_000);
      expect(claim?.job.id).toBe(active.id);
      const terminal = repo.enqueue({ ...payload, content: "terminal" }, { idempotencyKey: "terminal" }).job;
      repo.db.prepare("UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", terminal.id);
      repo.db.prepare("INSERT INTO deliveries(id,job_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("ambiguous-1", active.id, "ambiguous", "{}", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
      const policy = { archiveDir: dir, jobs: { completed: 1 }, deliveries: { sent: 1 }, idempotencyKeysMs: 1 };
      const dry = await pruneRetention(repo.db, policy, { at: new Date("2025-01-01T00:00:00.000Z"), dryRun: true });
      expect(dry.planned).toBeGreaterThan(0);
      expect(repo.get(active.id)).toBeDefined();
      const result = await pruneRetention(repo.db, policy, { at: new Date("2025-01-01T00:00:00.000Z") });
      expect(result.deleted).toBeGreaterThan(0);
      expect(repo.get(active.id)).toBeDefined();
      expect(repo.getDelivery(active.id)?.status).toBe("ambiguous");
    } finally { repo.close(); }
  });

  it("does not delete when archive creation fails", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = join(await mkdtemp(join(tmpdir(), "retention-fail-")), "not-a-dir");
    await writeFile(dir, "block");
    try {
      const job = repo.enqueue(payload).job;
      repo.db.prepare("UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", job.id);
      await expect(pruneRetention(repo.db, { archiveDir: dir, jobs: { completed: 1 } }, { at: new Date("2025-01-01T00:00:00.000Z") })).rejects.toThrow();
      expect(repo.get(job.id)).toBeDefined();
    } finally { repo.close(); }
  });

  it("requires an archive directory only for non-dry pruning and never overwrites exports", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "retention-collision-"));
    const at = new Date("2025-01-01T00:00:00.000Z");
    try {
      const job = repo.enqueue(payload).job;
      repo.db.prepare("UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", job.id);
      const dry = await pruneRetention(repo.db, { jobs: { completed: 1 } }, { at, dryRun: true });
      expect(dry.planned).toBe(1);
      await expect(pruneRetention(repo.db, { jobs: { completed: 1 } }, { at })).rejects.toThrow("archiveDir is required");
      expect(repo.get(job.id)).toBeDefined();
      const first = await pruneRetention(repo.db, { archiveDir: dir, jobs: { completed: 1 } }, { at });
      expect(first.archivePaths).toHaveLength(1);
      const firstBody = await readFile(first.archivePaths[0], "utf8");

      const secondRepo = new QueueRepository(openRuntimeDb(":memory:"));
      try {
        const secondJob = secondRepo.enqueue({ ...payload, content: "second" }).job;
        secondRepo.db.prepare("UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", secondJob.id);
        const second = await pruneRetention(secondRepo.db, { archiveDir: dir, jobs: { completed: 1 } }, { at });
        expect(second.archivePaths[0]).not.toBe(first.archivePaths[0]);
        expect(await readFile(first.archivePaths[0], "utf8")).toBe(firstBody);
      } finally { secondRepo.close(); }
    } finally { repo.close(); }
  });
  it("does not delete earlier batches when a later archive export fails", async () => {
    vi.resetModules();
    vi.doMock("node:crypto", async () => {
      const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
      return { ...actual, randomUUID: () => "fixed-retention-test-id" };
    });
    try {
      const { pruneRetention: isolatedPruneRetention } = await import("./retention.js");
      const repo = new QueueRepository(openRuntimeDb(":memory:"));
      const dir = await mkdtemp(join(tmpdir(), "retention-late-fail-"));
      const at = new Date("2025-01-01T00:00:00.000Z");
      try {
        const firstJob = repo.enqueue({ ...payload, content: "first" }).job;
        const secondJob = repo.enqueue({ ...payload, content: "second" }).job;
        repo.db.prepare("UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id IN (?,?)").run("2020-01-01T00:00:00.000Z", firstJob.id, secondJob.id);
        const stamp = at.toISOString().replace(/[:.]/g, "-");
        const blockedSecondTarget = join(dir, `runtime-retention-${stamp}-1-fixed-retention-test-id.jsonl`);
        await writeFile(blockedSecondTarget, "pre-existing archive");

        await expect(isolatedPruneRetention(repo.db, { archiveDir: dir, jobs: { completed: 1 }, batchSize: 1 }, { at })).rejects.toThrow();
        expect(repo.get(firstJob.id)).toBeDefined();
        expect(repo.get(secondJob.id)).toBeDefined();
        expect(await readdir(dir)).toEqual([blockedSecondTarget.split("/").pop()]);
      } finally { repo.close(); }
    } finally {
      vi.doUnmock("node:crypto");
      vi.resetModules();
    }
  });
  it("protects terminal jobs whose newer or non-retained deliveries would cascade", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "retention-child-protect-"));
    try {
      const job = repo.enqueue(payload).job;
      repo.db.prepare("UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", job.id);
      repo.db.prepare("INSERT INTO deliveries(id,job_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("new-sent", job.id, "sent", "{}", "2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z");
      const policy = { archiveDir: dir, jobs: { completed: 1 }, deliveries: { sent: 1 } };
      expect(planRetention(repo.db, policy, new Date("2025-01-01T00:00:00.000Z")).items).toEqual([]);
      const result = await pruneRetention(repo.db, policy, { at: new Date("2025-01-01T00:00:00.000Z") });
      expect(result.deleted).toBe(0);
      expect(repo.get(job.id)).toBeDefined();
      expect(repo.getDelivery(job.id)?.status).toBe("sent");
    } finally { repo.close(); }
  });

  it("archives and deletes eligible deliveries before their terminal parent", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "retention-child-archive-"));
    try {
      const job = repo.enqueue(payload).job;
      repo.db.prepare("UPDATE jobs SET status='completed',result_state='succeeded',succeeded=1,updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", job.id);
      repo.db.prepare("INSERT INTO deliveries(id,job_id,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run("old-failed", job.id, "failed", "{}", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");
      const result = await pruneRetention(repo.db, { archiveDir: dir, jobs: { completed: 1 }, deliveries: { failed: 1 }, batchSize: 1 }, { at: new Date("2025-01-01T00:00:00.000Z") });
      expect(result.deleted).toBe(2);
      expect(repo.get(job.id)).toBeUndefined();
      expect(repo.db.prepare("SELECT 1 FROM deliveries WHERE id=?").get("old-failed")).toBeUndefined();
      const archive = (await Promise.all(result.archivePaths.map((archivePath) => readFile(archivePath, "utf8")))).join("");
      expect(archive).toContain('"kind":"delivery"');
      expect(archive).toContain('"kind":"job"');
    } finally { repo.close(); }
  });

  it("retains idempotency keys referenced by terminal jobs", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    const dir = await mkdtemp(join(tmpdir(), "retention-idempotency-"));
    try {
      const first = repo.enqueue(payload, { idempotencyKey: "dedupe-key" }).job;
      const claim = repo.claim("worker");
      repo.commitResult(first.id, claim!.fencingToken, "done");
      repo.db.prepare("UPDATE jobs SET updated_at=?,completed_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", first.id);
      repo.db.prepare("UPDATE idempotency_keys SET created_at=?,completed_at=? WHERE key=?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z", "dedupe-key");
      const policy = { archiveDir: dir, idempotencyKeysMs: 1 };
      expect(planRetention(repo.db, policy, new Date("2025-01-01T00:00:00.000Z")).items).toEqual([]);
      await pruneRetention(repo.db, policy, { at: new Date("2025-01-01T00:00:00.000Z") });
      expect(repo.enqueue({ ...payload, content: "replay" }, { idempotencyKey: "dedupe-key" }).inserted).toBe(false);
    } finally { repo.close(); }
  });
});
