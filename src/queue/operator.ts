import type Database from "better-sqlite3";
import { resolveRssDbPath, tryOpenRssDb } from "../rss/store.js";
import {
  type BackupValidation,
  backupRuntimeDatabase,
  type RuntimeHealth,
  runtimeHealthCheck,
} from "./backup.js";
import {
  collectObservability,
  type ObservabilitySnapshot,
  type RssDbInspection,
} from "./observability.js";
import {
  pruneRuntimeRetention,
  type RetentionPolicy,
  type RetentionResult,
} from "./retention.js";

export interface RuntimeOperatorOptions {
  at?: Date;
  staleAfterMs?: number;
  /** Validate an existing backup without creating or replacing one. */
  backupPath?: string;
  /** Explicitly create a backup as an operator action. */
  backupDestination?: string;
  /** Retention is never run unless this option is supplied; dry-run defaults to true. */
  retention?: { policy: RetentionPolicy; dryRun?: boolean };
  /** The live RSS store used for reconciliation metrics and alerts. */
  rssDb?: Database.Database;
  /** RSS state paths to inspect in addition to the explicitly supplied store. */
  rssDbPaths?: readonly string[];
}

export interface RuntimeOperatorReport {
  health: RuntimeHealth;
  observability: ObservabilitySnapshot;
  backup: BackupValidation | null;
  retention: RetentionResult | null;
}

/**
 * Run non-mutating runtime inspection and explicitly requested maintenance.
 * The default path only reads queue state; pruning and backup creation are opt-in.
 */
export async function runRuntimeOperator(
  db: Database.Database,
  options: RuntimeOperatorOptions = {},
): Promise<RuntimeOperatorReport> {
  const backup = options.backupDestination
    ? await backupRuntimeDatabase(db, options.backupDestination)
    : null;
  const health = await runtimeHealthCheck(db, {
    backupPath: options.backupPath ?? options.backupDestination,
  });
  const rssEntries: RssDbInspection[] = options.rssDb
    ? [{ path: "provided", db: options.rssDb }]
    : [];
  const rssErrors: Array<{ path: string; error: string }> = [];
  const paths = new Set<string>();
  if (options.rssDbPaths) {
    paths.add(resolveRssDbPath());
    for (const configuredPath of options.rssDbPaths)
      paths.add(resolveRssDbPath(configuredPath));
  } else if (!options.rssDb) {
    paths.add(resolveRssDbPath());
  }
  const opened: Database.Database[] = [];
  for (const rssPath of paths) {
    const result = tryOpenRssDb(rssPath);
    if (!result.ok) {
      rssErrors.push({ path: result.path, error: result.error });
      continue;
    }
    opened.push(result.db);
    rssEntries.push({ path: result.path, db: result.db });
  }
  let observability: ObservabilitySnapshot;
  try {
    observability = collectObservability(db, undefined, {
      at: options.at,
      staleAfterMs: options.staleAfterMs,
      rssDbs: rssEntries,
      rssErrors,
    });
  } finally {
    for (const rssDb of opened) rssDb.close();
  }
  const retention = options.retention
    ? await pruneRuntimeRetention(db, options.retention.policy, {
        at: options.at,
        dryRun: options.retention.dryRun ?? true,
      })
    : null;
  return { health, observability, backup, retention };
}
