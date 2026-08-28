import { mkdirSync } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const SCHEMA_VERSION = 1;

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
  sourceItems: number;
  newItems: number;
  updatedItems: number;
}

export interface SyncRunRecord {
  startedAt: string;
  completedAt: string;
  status: XSavedSyncStatus;
  bookmarksFetched?: number | null;
  likesFetched?: number | null;
  newItems: number;
  updatedItems: number;
  error?: string | null;
  details?: unknown;
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

function ensureSchema(db: Database.Database): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `x-saved schema version ${version} is newer than supported ${SCHEMA_VERSION}`,
    );
  }

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
      baseline INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0, 1)),
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_item_state (
      tweet_id TEXT PRIMARY KEY REFERENCES x_items(tweet_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'inbox'
        CHECK (status IN ('inbox', 'reviewed', 'keep', 'try', 'done', 'ignore')),
      priority INTEGER CHECK (priority IS NULL OR (priority >= 0 AND priority <= 100)),
      summary TEXT,
      note TEXT,
      processed_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS x_tags (
      tweet_id TEXT NOT NULL REFERENCES x_items(tweet_id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (tweet_id, tag)
    );

    CREATE TABLE IF NOT EXISTS x_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
      bookmarks_fetched INTEGER,
      likes_fetched INTEGER,
      new_items INTEGER NOT NULL DEFAULT 0,
      updated_items INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      details_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS x_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_x_items_last_seen
      ON x_items(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_x_items_baseline
      ON x_items(baseline, first_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_x_item_state_status
      ON x_item_state(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_x_tags_tag
      ON x_tags(tag, tweet_id);
    CREATE INDEX IF NOT EXISTS idx_x_sync_runs_completed
      ON x_sync_runs(completed_at DESC);
  `);

  if (version === 0) {
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
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
    .get(selector, selector.replace(/^@/, ""), selector) as AccountRow | undefined;
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
  const collectionAccountClause = accountId ? "AND c.account_id = ?" : "";
  const tweetAccountClause = accountId ? "AND t.account_id = ?" : "";

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
          OR (t.liked = 1 ${tweetAccountClause})
        THEN 1 ELSE 0 END AS liked,
        CASE WHEN
          EXISTS (
            SELECT 1 FROM tweet_collections c
            WHERE c.tweet_id = t.id
              AND c.kind = 'bookmarks'
              ${collectionAccountClause}
          )
          OR (t.bookmarked = 1 ${tweetAccountClause})
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
  return (accountId
    ? statement.all(accountId, accountId, accountId, accountId)
    : statement.all()) as BirdclawRow[];
}

export function ingestBirdclawSavedItems(options?: {
  birdclawDbPath?: string;
  xSavedDb?: Database.Database;
  xSavedDbPath?: string;
  account?: string;
  now?: string;
}): IngestResult {
  const now = options?.now ?? new Date().toISOString();
  const sourcePath = resolveBirdclawDbPath(options?.birdclawDbPath);
  const sourceDb = new Database(sourcePath, {
    readonly: true,
    fileMustExist: true,
  });
  const ownsTarget = options?.xSavedDb === undefined;
  const targetDb =
    options?.xSavedDb ?? openXSavedDb(resolveXSavedDbPath(options?.xSavedDbPath));

  try {
    const rows = loadBirdclawRows(sourceDb, options?.account);
    const existingRows = targetDb
      .prepare("SELECT tweet_id FROM x_items")
      .all() as ExistingItemRow[];
    const existing = new Set(existingRows.map((row) => row.tweet_id));

    const upsertItem = targetDb.prepare(`
      INSERT INTO x_items (
        tweet_id,
        text,
        author_handle,
        url,
        tweet_created_at,
        external_urls_json,
        seen_liked,
        seen_bookmarked,
        baseline,
        first_seen_at,
        last_seen_at
      ) VALUES (
        @tweetId,
        @text,
        @authorHandle,
        @url,
        @tweetCreatedAt,
        @externalUrlsJson,
        @seenLiked,
        @seenBookmarked,
        0,
        @now,
        @now
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
        tweet_id, status, priority, summary, note, processed_at, updated_at
      ) VALUES (?, 'inbox', NULL, NULL, NULL, NULL, ?)
    `);

    let newItems = 0;
    let updatedItems = 0;
    const write = targetDb.transaction(() => {
      for (const row of rows) {
        const authorHandle = row.author_handle ?? "";
        const tweetId = String(row.id);
        const url = authorHandle
          ? `https://x.com/${authorHandle}/status/${tweetId}`
          : `https://x.com/i/status/${tweetId}`;
        upsertItem.run({
          tweetId,
          text: row.text ?? "",
          authorHandle,
          url,
          tweetCreatedAt: row.created_at,
          externalUrlsJson: JSON.stringify(extractExternalUrls(row.entities_json)),
          seenLiked: row.liked ? 1 : 0,
          seenBookmarked: row.bookmarked ? 1 : 0,
          now,
        });
        ensureState.run(tweetId, now);
        if (existing.has(tweetId)) updatedItems += 1;
        else newItems += 1;
      }
    });
    write();

    return {
      sourceItems: rows.length,
      newItems,
      updatedItems,
    };
  } finally {
    sourceDb.close();
    if (ownsTarget) targetDb.close();
  }
}

export function initializeHistoricalBaseline(
  db: Database.Database,
  now = new Date().toISOString(),
): { applied: boolean; count: number } {
  const current = db
    .prepare("SELECT value FROM x_meta WHERE key = 'baseline_initialized_at'")
    .get() as { value: string } | undefined;
  if (current) return { applied: false, count: 0 };

  const result = db.transaction(() => {
    const update = db.prepare("UPDATE x_items SET baseline = 1").run();
    db.prepare(
      "INSERT INTO x_meta (key, value) VALUES ('baseline_initialized_at', ?)",
    ).run(now);
    return update.changes;
  })();
  return { applied: true, count: result };
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
        bookmarks_fetched,
        likes_fetched,
        new_items,
        updated_items,
        error,
        details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      record.startedAt,
      record.completedAt,
      record.status,
      record.bookmarksFetched ?? null,
      record.likesFetched ?? null,
      record.newItems,
      record.updatedItems,
      record.error ?? null,
      JSON.stringify(record.details ?? {}),
    );
  return Number(result.lastInsertRowid);
}

export async function backupXSavedDatabase(
  dbPath = resolveXSavedDbPath(),
  keep = 14,
): Promise<string> {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error("x-saved backup retention must be a positive integer");
  }
  const resolved = path.resolve(dbPath);
  const backupDir = path.join(path.dirname(resolved), "backups");
  await mkdir(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(backupDir, `${stamp}.sqlite`);

  const db = new Database(resolved, { fileMustExist: true });
  try {
    await db.backup(destination);
  } finally {
    db.close();
  }

  const files = (await readdir(backupDir))
    .filter((name) => name.endsWith(".sqlite"))
    .sort()
    .reverse();
  await Promise.all(
    files.slice(keep).map((name) => unlink(path.join(backupDir, name))),
  );
  return destination;
}
