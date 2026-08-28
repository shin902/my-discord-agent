import {
  syncBirdclawSavedCollections,
  type BirdclawTransport,
} from "./birdclaw.js";
import {
  backupXSavedDatabase,
  ingestBirdclawSavedItems,
  openXSavedDb,
  recordSyncRun,
  resolveXSavedDbPath,
  type XSavedSyncStatus,
} from "./store.js";

export interface XSavedSyncOptions {
  mode?: BirdclawTransport;
  limit?: number;
  maxPages?: number;
  account?: string;
  birdclawDbPath?: string;
  xSavedDbPath?: string;
  backupKeep?: number;
}

export interface XSavedSyncResult {
  status: XSavedSyncStatus;
  startedAt: string;
  completedAt: string;
  newItems: number;
  updatedItems: number;
  sourceItems: number;
  bookmarksFetched: number | null;
  likesFetched: number | null;
  errors: string[];
  backupPath: string | null;
}

export async function runXSavedSync(
  options: XSavedSyncOptions = {},
): Promise<XSavedSyncResult> {
  const startedAt = new Date().toISOString();
  const xSavedDbPath = resolveXSavedDbPath(options.xSavedDbPath);
  const syncResult = await syncBirdclawSavedCollections({
    mode: options.mode ?? "xurl",
    limit: options.limit ?? 100,
    maxPages: options.maxPages ?? 3,
    account: options.account,
  });

  const errors = [syncResult.bookmarks.error, syncResult.likes.error].filter(
    (value): value is string => Boolean(value),
  );
  let status: XSavedSyncStatus =
    errors.length === 0 ? "success" : errors.length === 1 ? "partial" : "failed";
  let sourceItems = 0;
  let newItems = 0;
  let updatedItems = 0;
  let backupPath: string | null = null;

  const targetDb = openXSavedDb(xSavedDbPath);
  try {
    try {
      const ingest = ingestBirdclawSavedItems({
        birdclawDbPath: options.birdclawDbPath,
        xSavedDb: targetDb,
        account: options.account,
      });
      sourceItems = ingest.sourceItems;
      newItems = ingest.newItems;
      updatedItems = ingest.updatedItems;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`ingest: ${message}`);
      status = "failed";
    }

    try {
      backupPath = await backupXSavedDatabase(
        xSavedDbPath,
        options.backupKeep ?? 14,
      );
    } catch (error) {
      errors.push(
        `backup: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (status === "success") status = "partial";
    }

    const completedAt = new Date().toISOString();
    recordSyncRun(targetDb, {
      startedAt,
      completedAt,
      status,
      bookmarksFetched: syncResult.bookmarks.fetched,
      likesFetched: syncResult.likes.fetched,
      newItems,
      updatedItems,
      error: errors.length > 0 ? errors.join("\n") : null,
      details: {
        bookmarks: syncResult.bookmarks.output,
        likes: syncResult.likes.output,
        backupPath,
      },
    });

    return {
      status,
      startedAt,
      completedAt,
      newItems,
      updatedItems,
      sourceItems,
      bookmarksFetched: syncResult.bookmarks.fetched,
      likesFetched: syncResult.likes.fetched,
      errors,
      backupPath,
    };
  } finally {
    targetDb.close();
  }
}
