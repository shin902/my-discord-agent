import type { Stats } from "node:fs";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";

async function canonicalPath(value: string): Promise<string> {
  const absolute = path.resolve(value);
  try {
    return await realpath(absolute);
  } catch {
    try {
      return path.join(
        await realpath(path.dirname(absolute)),
        path.basename(absolute),
      );
    } catch {
      return absolute;
    }
  }
}

async function isLiveDatabaseDestination(
  db: Database.Database,
  destination: string,
): Promise<boolean> {
  // better-sqlite3 reports :memory: for an in-memory database, which has no
  // filesystem destination that could be accidentally overwritten.
  if (!db.name || db.name === ":memory:") return false;
  if ((await canonicalPath(db.name)) === (await canonicalPath(destination)))
    return true;
  try {
    const [source, target] = await Promise.all([
      stat(db.name),
      stat(destination),
    ]);
    return source.dev === target.dev && source.ino === target.ino;
  } catch {
    return false;
  }
}

export interface BackupValidation {
  path: string;
  exists: boolean;
  integrity: boolean;
  restored: boolean;
  error?: string;
  timestamp?: string;
}
export interface RuntimeHealth {
  ok: boolean;
  integrity: "ok" | "failed";
  walCheckpoint: { busy: number; log: number; checkpointed: number } | null;
  backup: BackupValidation | null;
}

function integrity(db: Database.Database): boolean {
  try {
    return db.pragma("integrity_check", { simple: true }) === "ok";
  } catch {
    return false;
  }
}
function checkpoint(
  db: Database.Database,
): { busy: number; log: number; checkpointed: number } | null {
  try {
    const value = db.pragma("wal_checkpoint(PASSIVE)", {
      simple: false,
    });
    const row = z
      .object({
        busy: z.number(),
        log: z.number(),
        checkpointed: z.number(),
      })
      .optional()
      .parse(Array.isArray(value) ? value[0] : undefined);
    if (row) return row;
    return null;
  } catch {
    return null;
  }
}

/** Make a consistent SQLite backup, then open it read-only to validate restore and integrity. */
export async function backupRuntimeDatabase(
  db: Database.Database,
  destination: string,
): Promise<BackupValidation> {
  if (await isLiveDatabaseDestination(db, destination)) {
    throw new Error(
      "backup destination must differ from the live runtime database",
    );
  }
  await mkdir(path.dirname(destination), { recursive: true });
  db.pragma("wal_checkpoint(PASSIVE)");
  await writeFile(destination, db.serialize());
  return validateRuntimeBackup(destination);
}

export async function validateRuntimeBackup(
  backupPath: string,
): Promise<BackupValidation> {
  let info: Stats;
  try {
    info = await stat(backupPath);
  } catch (error) {
    return {
      path: backupPath,
      exists: false,
      integrity: false,
      restored: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  let restored: Database.Database | undefined;
  try {
    restored = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    let valid: boolean;
    try {
      valid = restored.pragma("integrity_check", { simple: true }) === "ok";
    } catch (error) {
      return {
        path: backupPath,
        exists: true,
        integrity: false,
        restored: false,
        timestamp: info.mtime.toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const result: BackupValidation = {
      path: backupPath,
      exists: true,
      integrity: valid,
      restored: valid,
      timestamp: info.mtime.toISOString(),
    };
    if (!valid) result.error = "SQLite integrity_check failed";
    return result;
  } catch (error) {
    return {
      path: backupPath,
      exists: true,
      integrity: false,
      restored: false,
      timestamp: info.mtime.toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    restored?.close();
  }
}

export async function runtimeHealthCheck(
  db: Database.Database,
  options: { backupPath?: string } = {},
): Promise<RuntimeHealth> {
  const integrityOk = integrity(db);
  const walCheckpoint = checkpoint(db);
  const backup = options.backupPath
    ? await validateRuntimeBackup(options.backupPath)
    : null;
  return {
    ok:
      integrityOk &&
      (walCheckpoint === null || walCheckpoint.busy === 0) &&
      (backup === null || backup.restored),
    integrity: integrityOk ? "ok" : "failed",
    walCheckpoint,
    backup,
  };
}
