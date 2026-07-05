import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

export const DEFAULT_X_COOKIE_FILE = path.join(ROOT, "data/x-cookies.json");
export const DEFAULT_X_COOKIE_MAX_AGE_DAYS = 7;

export type StoredXCookies = {
  cookieHeader: string;
  csrfToken: string;
  updatedAt: string;
};

export type XCookieStoreOptions = {
  cookieFile?: string;
  maxAgeDays?: number;
  nowMs?: number;
};

export class XCookieMissingError extends Error {
  constructor() {
    super("x.com session cookie file is missing.");
    this.name = "XCookieMissingError";
  }
}

export class XCookieInvalidError extends Error {
  constructor() {
    super("x.com session cookie file is invalid.");
    this.name = "XCookieInvalidError";
  }
}

export class XCookieStaleError extends Error {
  constructor(ageDays: number, maxAgeDays: number) {
    super(
      `x.com session cookie is stale (${ageDays.toFixed(1)} days > ${maxAgeDays} days).`,
    );
    this.name = "XCookieStaleError";
  }
}

function resolveDataPath(input: string | undefined): string {
  if (!input) return DEFAULT_X_COOKIE_FILE;
  return path.isAbsolute(input) ? input : path.resolve(ROOT, input);
}

function assertStoredCookies(value: unknown): StoredXCookies {
  if (value === null || typeof value !== "object") {
    throw new XCookieInvalidError();
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.cookieHeader !== "string" ||
    record.cookieHeader.length === 0 ||
    typeof record.csrfToken !== "string" ||
    record.csrfToken.length === 0 ||
    typeof record.updatedAt !== "string" ||
    record.updatedAt.length === 0
  ) {
    throw new XCookieInvalidError();
  }
  return {
    cookieHeader: record.cookieHeader,
    csrfToken: record.csrfToken,
    updatedAt: record.updatedAt,
  };
}

export async function readXCookieStore(
  options: XCookieStoreOptions = {},
): Promise<StoredXCookies> {
  const cookieFile = resolveDataPath(options.cookieFile);
  let raw: string;
  try {
    raw = await readFile(cookieFile, "utf-8");
  } catch {
    throw new XCookieMissingError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new XCookieInvalidError();
  }
  const stored = assertStoredCookies(parsed);

  const updatedAtMs = new Date(stored.updatedAt).getTime();
  if (!Number.isFinite(updatedAtMs)) {
    throw new XCookieInvalidError();
  }

  const maxAgeDays = options.maxAgeDays ?? DEFAULT_X_COOKIE_MAX_AGE_DAYS;
  const nowMs = options.nowMs ?? Date.now();
  const ageDays = (nowMs - updatedAtMs) / (24 * 60 * 60 * 1000);
  if (ageDays > maxAgeDays) {
    throw new XCookieStaleError(ageDays, maxAgeDays);
  }

  return stored;
}
