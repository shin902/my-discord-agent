import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveBirdclawDbPath, type XSavedItem } from "./store.js";

const execFileAsync = promisify(execFile);

export type BirdclawTransport = "auto" | "xurl" | "bird";
export type BirdclawCollection = "bookmarks" | "likes";

export interface BirdclawCommandResult {
  ok: boolean;
  collection: BirdclawCollection;
  items: XSavedItem[];
  error: string | null;
}

function birdclawBinary(): string {
  return process.env.BIRDCLAW_BIN || "birdclaw";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`BirdClaw response is missing ${field}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function extractExternalUrls(entities: unknown): string[] | undefined {
  if (!isRecord(entities) || !Array.isArray(entities.urls)) return undefined;
  const result = new Set<string>();
  for (const entry of entities.urls) {
    if (!isRecord(entry)) continue;
    const candidate = [entry.expanded_url, entry.expandedUrl, entry.url].find(
      (value): value is string => typeof value === "string",
    );
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
      // Ignore malformed URLs from the source response.
    }
  }
  return [...result];
}

function parseJsonEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("BirdClaw returned empty JSON output");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error("BirdClaw returned invalid JSON", { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error("BirdClaw returned an invalid JSON envelope");
  }
  return parsed;
}

function parseJsonOutput(
  stdout: string,
  collection: BirdclawCollection,
): XSavedItem[] {
  const parsed = parseJsonEnvelope(stdout);
  const payload = parsed.payload;
  if (!isRecord(payload)) {
    throw new Error("BirdClaw response is missing payload data");
  }
  const data = payload.data;
  if (data === undefined) {
    const meta = payload.meta;
    if (isRecord(meta) && meta.result_count === 0) return [];
    throw new Error("BirdClaw response is missing payload data");
  }
  if (!Array.isArray(data)) {
    throw new Error("BirdClaw response contains invalid payload data");
  }
  const includes = isRecord(payload.includes) ? payload.includes : undefined;
  const users = new Map<string, string>();
  if (Array.isArray(includes?.users)) {
    for (const user of includes.users) {
      if (!isRecord(user)) continue;
      if (typeof user.id === "string" && typeof user.username === "string") {
        users.set(user.id, user.username);
      }
    }
  }

  return data.map((tweet): XSavedItem => {
    if (!isRecord(tweet)) {
      throw new Error("BirdClaw response contains an invalid tweet");
    }
    const tweetId = requiredString(tweet.id, "tweet id");
    const authorId = requiredString(tweet.author_id, "tweet author id");
    const authorHandle = users.get(authorId);
    const tweetCreatedAt = optionalString(tweet.created_at);
    const externalUrls = extractExternalUrls(tweet.entities);
    return {
      tweetId,
      text: requiredString(tweet.text, "tweet text"),
      ...(authorHandle === undefined ? {} : { authorHandle }),
      ...(tweetCreatedAt === null ? {} : { tweetCreatedAt }),
      ...(externalUrls === undefined ? {} : { externalUrls }),
      seenLiked: collection === "likes",
      seenBookmarked: collection === "bookmarks",
    };
  });
}

const BIRDCLAW_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "NO_COLOR",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

function buildBirdclawEnv(birdclawDbPath?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BIRDCLAW_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.env.BIRDCLAW_HOME !== undefined) {
    env.BIRDCLAW_HOME = process.env.BIRDCLAW_HOME;
  }
  env.BIRDCLAW_DISABLE_LIVE_WRITES = "1";
  env.BIRDCLAW_DB_PATH = resolveBirdclawDbPath(birdclawDbPath);
  return env;
}

async function runBirdclaw(
  args: string[],
  collection: BirdclawCollection,
  birdclawDbPath?: string,
): Promise<XSavedItem[]> {
  const { stdout } = await execFileAsync(birdclawBinary(), args, {
    env: buildBirdclawEnv(birdclawDbPath),
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return parseJsonOutput(stdout, collection);
}

export async function importBirdclawArchive(
  archivePath: string,
): Promise<void> {
  const { stdout } = await execFileAsync(
    birdclawBinary(),
    [
      "import",
      "archive",
      archivePath,
      "--select",
      "likes,bookmarks,profiles",
      "--json",
    ],
    {
      env: buildBirdclawEnv(),
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    },
  );
  parseJsonEnvelope(stdout);
}

async function syncCollection(options: {
  collection: BirdclawCollection;
  mode: BirdclawTransport;
  limit: number;
  maxPages: number;
  account?: string;
  birdclawDbPath?: string;
}): Promise<BirdclawCommandResult> {
  const args = [
    "sync",
    options.collection,
    "--mode",
    options.mode,
    "--limit",
    String(options.limit),
    "--max-pages",
    String(options.maxPages),
    "--early-stop",
    "--refresh",
    "--json",
  ];
  if (options.account) {
    args.push("--account", options.account);
  }

  try {
    const items = await runBirdclaw(
      args,
      options.collection,
      options.birdclawDbPath,
    );
    return {
      ok: true,
      collection: options.collection,
      items,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      collection: options.collection,
      items: [],
      error: message,
    };
  }
}

export async function syncBirdclawSavedCollections(options: {
  mode: BirdclawTransport;
  limit: number;
  maxPages: number;
  account?: string;
  birdclawDbPath?: string;
}): Promise<{
  bookmarks: BirdclawCommandResult;
  likes: BirdclawCommandResult;
}> {
  const birdclawDbPath = options.birdclawDbPath
    ? resolveBirdclawDbPath(options.birdclawDbPath)
    : undefined;
  const bookmarks = await syncCollection({
    ...options,
    birdclawDbPath,
    collection: "bookmarks",
  });
  const likes = await syncCollection({
    ...options,
    birdclawDbPath,
    collection: "likes",
  });
  return { bookmarks, likes };
}
