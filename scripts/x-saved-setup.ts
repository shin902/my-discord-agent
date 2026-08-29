import { access } from "node:fs/promises";
import path from "node:path";
import { importBirdclawArchive } from "../src/integrations/x-saved/birdclaw.js";
import {
  backupXSavedDatabase,
  ingestBirdclawSavedItems,
  markInitialImportCompleted,
  openXSavedDb,
  resolveXSavedDbPath,
} from "../src/integrations/x-saved/store.js";

function parseArgs(argv: string[]): { archivePath?: string } {
  let archivePath: string | undefined;
  for (const arg of argv) {
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (archivePath) {
      throw new Error("only one archive path may be specified");
    }
    archivePath = path.resolve(arg);
  }
  return { archivePath };
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
    const initialImportCompleted = markInitialImportCompleted(db);
    console.log(
      JSON.stringify(
        { xSavedDbPath, ingest, initialImportCompleted },
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
