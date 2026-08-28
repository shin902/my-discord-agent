import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type BirdclawTransport = "auto" | "xurl" | "bird";
export type BirdclawCollection = "bookmarks" | "likes";

export interface BirdclawCommandResult {
  ok: boolean;
  collection: BirdclawCollection;
  fetched: number | null;
  output: unknown;
  error: string | null;
}

function birdclawBinary(): string {
  return process.env.BIRDCLAW_BIN || "birdclaw";
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return { raw: trimmed };
  }
}

function findFetchedCount(value: unknown): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFetchedCount(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  for (const key of [
    "fetched",
    "fetchedCount",
    "resultCount",
    "itemsObserved",
    "itemsFetched",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  for (const candidate of Object.values(record)) {
    const found = findFetchedCount(candidate);
    if (found !== null) return found;
  }
  return null;
}

async function runBirdclaw(args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync(birdclawBinary(), args, {
    env: {
      ...process.env,
      BIRDCLAW_DISABLE_LIVE_WRITES: "1",
    },
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return parseJsonOutput(stdout);
}

export async function importBirdclawArchive(
  archivePath: string,
): Promise<unknown> {
  return runBirdclaw([
    "import",
    "archive",
    archivePath,
    "--select",
    "likes,bookmarks,profiles",
    "--json",
  ]);
}

async function syncCollection(options: {
  collection: BirdclawCollection;
  mode: BirdclawTransport;
  limit: number;
  maxPages: number;
  account?: string;
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
    const output = await runBirdclaw(args);
    return {
      ok: true,
      collection: options.collection,
      fetched: findFetchedCount(output),
      output,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      collection: options.collection,
      fetched: null,
      output: {},
      error: message,
    };
  }
}

export async function syncBirdclawSavedCollections(options: {
  mode: BirdclawTransport;
  limit: number;
  maxPages: number;
  account?: string;
}): Promise<{
  bookmarks: BirdclawCommandResult;
  likes: BirdclawCommandResult;
}> {
  const bookmarks = await syncCollection({
    ...options,
    collection: "bookmarks",
  });
  const likes = await syncCollection({ ...options, collection: "likes" });
  return { bookmarks, likes };
}
