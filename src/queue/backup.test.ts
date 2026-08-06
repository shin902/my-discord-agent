import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { QueueRepository, openRuntimeDb } from "./repository.js";
import { backupRuntimeDatabase, runtimeHealthCheck, validateRuntimeBackup } from "./backup.js";

describe("runtime SQLite backup health", () => {
  it("backs up, restores, and validates integrity", async () => {
    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const dir = await mkdtemp(join(tmpdir(), "runtime-backup-"));
      const destination = join(dir, "runtime.sqlite");
      const validation = await backupRuntimeDatabase(repo.db, destination);
      expect(validation).toMatchObject({ exists: true, integrity: true, restored: true });
      const health = await runtimeHealthCheck(repo.db, { backupPath: destination });
      expect(health.ok).toBe(true);
      expect(health.integrity).toBe("ok");
    } finally { repo.close(); }
  });
  it("classifies an existing corrupt backup as invalid instead of missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-backup-corrupt-"));
    const destination = join(dir, "corrupt.sqlite");
    await writeFile(destination, "not a sqlite database");

    const validation = await validateRuntimeBackup(destination);
    expect(validation).toMatchObject({ exists: true, integrity: false, restored: false });
    expect(validation.error).toBeTruthy();

    const repo = new QueueRepository(openRuntimeDb(":memory:"));
    try {
      const health = await runtimeHealthCheck(repo.db, { backupPath: destination });
      expect(health.ok).toBe(false);
      expect(health.backup).toMatchObject({ exists: true, integrity: false, restored: false });
      expect(health.backup?.error).toBeTruthy();
    } finally {
      repo.close();
    }
  });
  it("rejects the live database and symlink aliases before checkpoint or copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "runtime-backup-live-"));
    const source = join(dir, "runtime.sqlite");
    const alias = join(dir, "runtime-alias.sqlite");
    const repo = new QueueRepository(openRuntimeDb(source));
    try {
      await symlink(source, alias);
      await expect(backupRuntimeDatabase(repo.db, alias)).rejects.toThrow("must differ");
      expect(repo.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get()).toBeDefined();
    } finally { repo.close(); }
  });
});
