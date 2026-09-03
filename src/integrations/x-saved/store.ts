import { mkdirSync } from "node:fs";
import { mkdir, readdir, realpath, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const SCHEMA_VERSION = 2;
const XSAVED_BACKUP_PREFIX = "x-saved-";
const LEGACY_XSAVED_BACKUP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.sqlite$/;

export const X_SAVED_STATUSES = [
  "inbox",
  "reviewed",
  "keep",
  "try",
  "done",
  "ignore",
] as const;

export type XSavedStatus = (typeof X_SAVED_STATUSES)[number];
export type XSavedSyncStatus = "success" | "partial" | "failed";

export interface IngestResult {
  newItems: number;
}

/** Normalized saved-post data accepted from a host-side source adapter. */
export interface XSavedItem {
  tweetId: string;
  text: string;
  authorHandle: string;
  tweetCreatedAt: string | null;
  externalUrls: string[];
  seenLiked: boolean;
  seenBookmarked: boolean;
}

/** A failure reading BirdClaw is an operational source failure, not a target DB failure. */
export class BirdclawSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BirdclawSourceError";
  }
}

export interface SyncRunRecord {
  startedAt: string;
  completedAt: string;
  status: XSavedSyncStatus;
  newItems: number;
  error?: string | null;
}

interface BirdclawRow {
  id: string;
  text: string;
  created_at: string | null;
  author_handle: string | null;
  liked: number;
  bookmarked: number;
  entities_json: string | null;
}

interface ExistingItemRow {
  tweet_id: string;
}

interface AccountRow {
  id: string;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveXSavedDbPath(override?: string): string {
  const configured = override ?? process.env.X_SAVED_DB_PATH;
  if (configured) return path.resolve(expandHome(configured));
  return path.join(ROOT, "data/x-saved/x-saved.sqlite");
}

export function resolveBirdclawDbPath(override?: string): string {
  const configured = override ?? process.env.BIRDCLAW_DB_PATH;
  if (configured) return path.resolve(expandHome(configured));
  const birdclawHome = process.env.BIRDCLAW_HOME
    ? path.resolve(expandHome(process.env.BIRDCLAW_HOME))
    : path.join(os.homedir(), ".birdclaw");
  return path.join(birdclawHome, "birdclaw.sqlite");
}

export function resolveXSavedBackupDir(override?: string): string {
  const configured = override ?? process.env.X_SAVED_BACKUP_DIR;
  if (configured) {
    const expanded = expandHome(configured);
    return path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(ROOT, expanded);
  }
  return path.join(ROOT, "data/x-saved-backups");
}

async function realpathWithNearestExistingAncestor(
  input: string,
): Promise<string> {
  let current = path.resolve(input);
  const suffix: string[] = [];

  while (true) {
    try {
      const canonical = await realpath(current);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_items (
      tweet_id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      author_handle TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      tweet_created_at TEXT,
      external_urls_json TEXT NOT NULL DEFAULT '[]',
      seen_liked INTEGER NOT NULL DEFAULT 0 CHECK (seen_liked IN (0, 1)),
      seen_bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (seen_bookmarked IN (0, 1)),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_item_state (
      tweet_id TEXT PRIMARY KEY REFERENCES x_items(tweet_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'inbox'
        CHECK (status IN ('inbox', 'reviewed', 'keep', 'try', 'done', 'ignore')),
      note TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
      new_items INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS x_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_x_items_last_seen
      ON x_items(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_x_item_state_status
      ON x_item_state(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_x_sync_runs_completed
      ON x_sync_runs(completed_at DESC);
  `);
}

function migrateSchemaV1(db: Database.Database): void {
  const migrate = db.transaction(() => {
    const baselineMode = db
      .prepare("SELECT value FROM x_meta WHERE key = 'baseline_mode'")
      .get() as { value: string } | undefined;
    const legacyMarker = db
      .prepare("SELECT value FROM x_meta WHERE key = 'baseline_initialized_at'")
      .get() as { value: string } | undefined;
    const inferredMarker = db
      .prepare(
        "SELECT MAX(first_seen_at) AS value FROM x_items WHERE baseline = 1",
      )
      .get() as { value: string | null };
    const initialImportCompletedAt =
      baselineMode?.value === "keep-backlog"
        ? undefined
        : (legacyMarker?.value ?? inferredMarker.value);
    if (initialImportCompletedAt) {
      db.prepare(
        "INSERT OR IGNORE INTO x_meta (key, value) VALUES ('initial_import_completed_at', ?)",
      ).run(initialImportCompletedAt);
    }

    // Keep the legacy columns and x_tags table so already-installed versions of
    // the x-saved skill remain usable while the schema rolls forward.
    db.exec(
      "DELETE FROM x_meta WHERE key IN ('baseline_initialized_at', 'baseline_mode')",
    );
  });
  migrate();
}

function ensureSchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `x-saved schema version ${version} is newer than supported ${SCHEMA_VERSION}`,
    );
  }
  if (version === 0) {
    createSchema(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    return;
  }
  if (version === 1) {
    migrateSchemaV1(db);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
  createSchema(db);
}

export function openXSavedDb(
  dbPath = resolveXSavedDbPath(),
): Database.Database {
  const resolved = path.resolve(dbPath);
  mkdirSync(path.dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  ensureSchema(db);
  return db;
}

function assertBirdclawSchema(db: Database.Database): void {
  const required = ["accounts", "profiles", "tweets", "tweet_collections"];
  const rows = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${required.map(() => "?").join(", ")})`,
    )
    .all(...required) as Array<{ name: string }>;
  const found = new Set(rows.map((row) => row.name));
  const missing = required.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(
      `BirdClaw database is missing expected tables: ${missing.join(", ")}`,
    );
  }
}

function resolveBirdclawAccountId(
  db: Database.Database,
  selector?: string,
): string | null {
  if (!selector) return null;
  const row = db
    .prepare(
      `SELECT id
       FROM accounts
       WHERE id = ? OR lower(handle) = lower(?) OR lower(name) = lower(?)
       LIMIT 1`,
    )
    .get(selector, selector.replace(/^@/, ""), selector) as
    | AccountRow
    | undefined;
  if (!row) {
    throw new Error(`BirdClaw account not found: ${selector}`);
  }
  return row.id;
}

function extractExternalUrls(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!parsed || typeof parsed !== "object") return [];
  const urls = (parsed as { urls?: unknown }).urls;
  if (!Array.isArray(urls)) return [];

  const result = new Set<string>();
  for (const entry of urls) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const candidate = [
      record.expandedUrl,
      record.expanded_url,
      record.url,
    ].find((value): value is string => typeof value === "string");
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      if (
        host === "x.com" ||
        host.endsWith(".x.com") ||
        host === "twitter.com" ||
        host.endsWith(".twitter.com") ||
        host === "t.co"
      ) {
        continue;
      }
      result.add(url.toString());
    } catch {
      // Ignore malformed archive/live URL entities.
    }
  }
  return [...result];
}

function loadBirdclawRows(
  sourceDb: Database.Database,
  account?: string,
): BirdclawRow[] {
  assertBirdclawSchema(sourceDb);
  const accountId = resolveBirdclawAccountId(sourceDb, account);
  const tweetColumns = new Set(
    (
      sourceDb.prepare("PRAGMA table_info(tweets)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  );
  const collectionAccountClause = accountId
    ? "AND c.account_id = @accountId"
    : "";
  const legacyTweetAccountClause =
    accountId && tweetColumns.has("account_id")
      ? "AND t.account_id = @accountId"
      : "";
  const legacyLikedClause = tweetColumns.has("liked")
    ? `OR (t.liked = 1 ${legacyTweetAccountClause})`
    : "";
  const legacyBookmarkedClause = tweetColumns.has("bookmarked")
    ? `OR (t.bookmarked = 1 ${legacyTweetAccountClause})`
    : "";

  const query = `
    WITH source AS (
      SELECT
        t.id,
        t.text,
        t.created_at,
        p.handle AS author_handle,
        t.entities_json,
        CASE WHEN
          EXISTS (
            SELECT 1 FROM tweet_collections c
            WHERE c.tweet_id = t.id
              AND c.kind = 'likes'
              ${collectionAccountClause}
          )
          ${legacyLikedClause}
        THEN 1 ELSE 0 END AS liked,
        CASE WHEN
          EXISTS (
            SELECT 1 FROM tweet_collections c
            WHERE c.tweet_id = t.id
              AND c.kind = 'bookmarks'
              ${collectionAccountClause}
          )
          ${legacyBookmarkedClause}
        THEN 1 ELSE 0 END AS bookmarked
      FROM tweets t
      LEFT JOIN profiles p ON p.id = t.author_profile_id
      WHERE t.deleted_at IS NULL
        AND t.superseded_at IS NULL
    )
    SELECT * FROM source
    WHERE liked = 1 OR bookmarked = 1
    ORDER BY created_at ASC, id ASC
  `;

  const statement = sourceDb.prepare(query);
  return (
    accountId ? statement.all({ accountId }) : statement.all()
  ) as BirdclawRow[];
}

export function ingestXSavedItems(
  items: readonly XSavedItem[],
  options?: {
    xSavedDb?: Database.Database;
    xSavedDbPath?: string;
    now?: string;
  },
): IngestResult {
  const now = options?.now ?? new Date().toISOString();
  const ownsTarget = options?.xSavedDb === undefined;
  const targetDb =
    options?.xSavedDb ??
    openXSavedDb(resolveXSavedDbPath(options?.xSavedDbPath));
  try {
    const existingRows = targetDb
      .prepare("SELECT tweet_id FROM x_items")
      .all() as ExistingItemRow[];
    const existing = new Set(existingRows.map((row) => row.tweet_id));

    const upsertItem = targetDb.prepare(`
      INSERT INTO x_items (
        tweet_id, text, author_handle, url, tweet_created_at,
        external_urls_json, seen_liked, seen_bookmarked,
        first_seen_at, last_seen_at
      ) VALUES (
        @tweetId, @text, @authorHandle, @url, @tweetCreatedAt,
        @externalUrlsJson, @seenLiked, @seenBookmarked, @now, @now
      )
      ON CONFLICT(tweet_id) DO UPDATE SET
        text = excluded.text,
        author_handle = excluded.author_handle,
        url = excluded.url,
        tweet_created_at = excluded.tweet_created_at,
        external_urls_json = excluded.external_urls_json,
        seen_liked = MAX(x_items.seen_liked, excluded.seen_liked),
        seen_bookmarked = MAX(x_items.seen_bookmarked, excluded.seen_bookmarked),
        last_seen_at = excluded.last_seen_at
    `);
    const ensureState = targetDb.prepare(`
      INSERT OR IGNORE INTO x_item_state (
        tweet_id, status, note, updated_at
      ) VALUES (?, 'inbox', NULL, ?)
    `);

    let newItems = 0;
    const write = targetDb.transaction(() => {
      for (const item of items) {
        const url = item.authorHandle
          ? `https://x.com/${item.authorHandle}/status/${item.tweetId}`
          : `https://x.com/i/status/${item.tweetId}`;
        upsertItem.run({
          tweetId: item.tweetId,
          text: item.text,
          authorHandle: item.authorHandle,
          url,
          tweetCreatedAt: item.tweetCreatedAt,
          externalUrlsJson: JSON.stringify(item.externalUrls),
          seenLiked: item.seenLiked ? 1 : 0,
          seenBookmarked: item.seenBookmarked ? 1 : 0,
          now,
        });
        ensureState.run(item.tweetId, now);
        if (!existing.has(item.tweetId)) {
          newItems += 1;
          existing.add(item.tweetId);
        }
      }
    });
    write();

    return { newItems };
  } finally {
    if (ownsTarget) targetDb.close();
  }
}

export function ingestBirdclawSavedItems(options?: {
  birdclawDbPath?: string;
  xSavedDb?: Database.Database;
  xSavedDbPath?: string;
  account?: string;
  now?: string;
}): IngestResult {
  const sourcePath = resolveBirdclawDbPath(options?.birdclawDbPath);
  let sourceDb: Database.Database | undefined;
  let rows: BirdclawRow[];
  try {
    sourceDb = new Database(sourcePath, {
      readonly: true,
      fileMustExist: true,
    });
    rows = loadBirdclawRows(sourceDb, options?.account);
  } catch (error) {
    throw new BirdclawSourceError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  } finally {
    sourceDb?.close();
  }

  return ingestXSavedItems(
    rows.map((row) => ({
      tweetId: String(row.id),
      text: row.text ?? "",
      authorHandle: row.author_handle ?? "",
      tweetCreatedAt: row.created_at,
      externalUrls: extractExternalUrls(row.entities_json),
      seenLiked: row.liked === 1,
      seenBookmarked: row.bookmarked === 1,
    })),
    options,
  );
}

export function markInitialImportCompleted(
  db: Database.Database,
  completedAt = new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      "INSERT OR IGNORE INTO x_meta (key, value) VALUES ('initial_import_completed_at', ?)",
    )
    .run(completedAt);
  return result.changes > 0;
}

export function recordSyncRun(
  db: Database.Database,
  record: SyncRunRecord,
): number {
  const result = db
    .prepare(
      `INSERT INTO x_sync_runs (
        started_at,
        completed_at,
        status,
        new_items,
        error
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      record.startedAt,
      record.completedAt,
      record.status,
      record.newItems,
      record.error ?? null,
    );
  return Number(result.lastInsertRowid);
}

export async function backupXSavedDatabase(
  dbPath = resolveXSavedDbPath(),
  keep = 14,
  backupDirOverride?: string,
): Promise<string> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("x-saved backup retention must be a positive integer");
  }
  const resolved = path.resolve(dbPath);
  const resolvedBackupDir = resolveXSavedBackupDir(backupDirOverride);
  const lexicalLiveDir = path.dirname(resolved);
  const configuredLiveDir = await realpath(lexicalLiveDir);
  const livePath = await realpath(resolved);
  const targetLiveDir = path.dirname(livePath);
  if (isPathWithin(lexicalLiveDir, resolvedBackupDir)) {
    throw new Error(
      "x-saved backup directory must be outside the live database directory",
    );
  }

  const backupDirCandidate =
    await realpathWithNearestExistingAncestor(resolvedBackupDir);
  if (
    isPathWithin(configuredLiveDir, backupDirCandidate) ||
    isPathWithin(targetLiveDir, backupDirCandidate)
  ) {
    throw new Error(
      "x-saved backup directory must be outside the live database directory",
    );
  }

  await mkdir(resolvedBackupDir, { recursive: true });
  const backupDir = await realpath(resolvedBackupDir);
  if (
    isPathWithin(configuredLiveDir, backupDir) ||
    isPathWithin(targetLiveDir, backupDir)
  ) {
    throw new Error(
      "x-saved backup directory must be outside the live database directory",
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(
    backupDir,
    `${XSAVED_BACKUP_PREFIX}${stamp}.sqlite`,
  );

  const db = new Database(resolved, { fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }

  const files = (await readdir(backupDir))
    .filter(
      (name) =>
        (name.startsWith(XSAVED_BACKUP_PREFIX) && name.endsWith(".sqlite")) ||
        LEGACY_XSAVED_BACKUP_PATTERN.test(name),
    )
    .sort()
    .reverse();
  await Promise.all(
    files.slice(keep).map((name) => unlink(path.join(backupDir, name))),
  );
  return destination;
}
