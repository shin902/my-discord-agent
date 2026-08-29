import {
  type BirdclawTransport,
  syncBirdclawSavedCollections,
} from "./birdclaw.js";
import {
  BirdclawSourceError,
  backupXSavedDatabase,
  ingestBirdclawSavedItems,
  openXSavedDb,
  recordSyncRun,
  resolveBirdclawDbPath,
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
  backupPath?: string;
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
  const birdclawDbPath = resolveBirdclawDbPath(options.birdclawDbPath);
  const syncResult = await syncBirdclawSavedCollections({
    mode: options.mode ?? "xurl",
    limit: options.limit ?? 100,
    maxPages: options.maxPages ?? 3,
    account: options.account,
    birdclawDbPath,
  });

  const errors = [syncResult.bookmarks.error, syncResult.likes.error].filter(
    (value): value is string => Boolean(value),
  );
  let status: XSavedSyncStatus =
    errors.length === 0
      ? "success"
      : errors.length === 1
        ? "partial"
        : "failed";
  let sourceItems = 0;
  let newItems = 0;
  let updatedItems = 0;
  let backupPath: string | null = null;

  const targetDb = openXSavedDb(xSavedDbPath);
  try {
    try {
      const ingest = ingestBirdclawSavedItems({
        birdclawDbPath,
        xSavedDb: targetDb,
        account: options.account,
      });
      sourceItems = ingest.sourceItems;
      newItems = ingest.newItems;
      updatedItems = ingest.updatedItems;
    } catch (error) {
      if (!(error instanceof BirdclawSourceError)) throw error;
      errors.push(`ingest: ${error.message}`);
      status = "failed";
    }

    backupPath = await backupXSavedDatabase(
      xSavedDbPath,
      options.backupKeep ?? 14,
      options.backupPath,
    );

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
