import { access } from "node:fs/promises";
import path from "node:path";
import { importBirdclawArchive } from "../src/integrations/x-saved/birdclaw.js";
import {
  backupXSavedDatabase,
  ingestBirdclawSavedItems,
  initializeHistoricalBaseline,
  openXSavedDb,
  resolveXSavedDbPath,
} from "../src/integrations/x-saved/store.js";

function parseArgs(argv: string[]): {
  archivePath?: string;
  keepBacklog: boolean;
} {
  let archivePath: string | undefined;
  let keepBacklog = false;
  for (const arg of argv) {
    if (arg === "--keep-backlog") {
      keepBacklog = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (archivePath) {
      throw new Error("only one archive path may be specified");
    }
    archivePath = path.resolve(arg);
  }
  return { archivePath, keepBacklog };
}

function initializeKeptBacklog(
  db: ReturnType<typeof openXSavedDb>,
  now = new Date().toISOString(),
): { applied: boolean; count: number } {
  const current = db
    .prepare("SELECT value FROM x_meta WHERE key = 'baseline_initialized_at'")
    .get() as { value: string } | undefined;
  if (current) return { applied: false, count: 0 };

  db.transaction(() => {
    db.prepare(
      "INSERT INTO x_meta (key, value) VALUES ('baseline_initialized_at', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO x_meta (key, value) VALUES ('baseline_mode', 'keep-backlog')",
    ).run();
  })();
  return { applied: true, count: 0 };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.archivePath) {
    await access(options.archivePath);
    console.log(`[x-saved] importing archive: ${options.archivePath}`);
    await importBirdclawArchive(options.archivePath);
  } else {
    console.log(
      "[x-saved] archive path omitted; ingesting the existing BirdClaw database",
    );
  }

  const xSavedDbPath = resolveXSavedDbPath();
  const db = openXSavedDb(xSavedDbPath);
  try {
    const ingest = ingestBirdclawSavedItems({ xSavedDb: db });
    const baseline = options.keepBacklog
      ? initializeKeptBacklog(db)
      : initializeHistoricalBaseline(db);
    if (!options.keepBacklog && baseline.applied) {
      db.prepare(
        "INSERT OR IGNORE INTO x_meta (key, value) VALUES ('baseline_mode', 'historical')",
      ).run();
    }
    console.log(
      JSON.stringify(
        {
          xSavedDbPath,
          ingest,
          baseline: options.keepBacklog
            ? { mode: "keep-backlog", ...baseline }
            : { mode: "historical", ...baseline },
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }

  const backupPath = await backupXSavedDatabase(xSavedDbPath, 14);
  console.log(`[x-saved] backup: ${backupPath}`);
}

main().catch((error) => {
  console.error(
    `[x-saved] setup failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
