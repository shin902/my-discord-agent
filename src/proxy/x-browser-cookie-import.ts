import { homedir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { saveXCookieHeader } from "./x-cookie-import.js";

export type BrowserCookieSource = "firefox" | "chromium" | "auto";

export type BrowserCookieImportOptions = {
  source?: BrowserCookieSource;
  dbPath?: string;
  profileDir?: string;
  cookieFile?: string;
  now?: Date;
};

type BrowserCookie = {
  host: string;
  name: string;
  value: string;
  expiresAtMs: number | null;
};

export class XBrowserCookieImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XBrowserCookieImportError";
  }
}

function resolvePath(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return path.join(homedir(), input.slice(2));
  return path.resolve(input);
}

function isXCookieHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\./, "");
  return (
    normalized === "x.com" ||
    normalized.endsWith(".x.com") ||
    normalized === "twitter.com" ||
    normalized.endsWith(".twitter.com")
  );
}

function isExpired(cookie: BrowserCookie, nowMs: number): boolean {
  return cookie.expiresAtMs !== null && cookie.expiresAtMs <= nowMs;
}

function cookieHeaderFromCookies(
  cookies: BrowserCookie[],
  nowMs: number,
): string {
  const currentCookies = cookies.filter(
    (cookie) => isXCookieHost(cookie.host) && !isExpired(cookie, nowMs),
  );
  const authToken = currentCookies.find(
    (cookie) => cookie.name === "auth_token",
  );
  if (!authToken) {
    throw new XBrowserCookieImportError(
      "X auth_token cookie was not found in browser DB.",
    );
  }
  const csrfToken = currentCookies.find((cookie) => cookie.name === "ct0");
  if (!csrfToken) {
    throw new XBrowserCookieImportError(
      "X ct0 cookie was not found in browser DB.",
    );
  }

  return currentCookies
    .sort((a, b) => `${a.host}:${a.name}`.localeCompare(`${b.host}:${b.name}`))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function readFirefoxCookies(dbPath: string): BrowserCookie[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT host, name, value, expiry
         FROM moz_cookies
         WHERE host LIKE '%x.com' OR host LIKE '%twitter.com'`,
      )
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          host: String(record.host ?? ""),
          name: String(record.name ?? ""),
          value: String(record.value ?? ""),
          expiresAtMs:
            typeof record.expiry === "number" ? record.expiry * 1000 : null,
        };
      });
  } finally {
    db.close();
  }
}

function chromiumExpiresAtMs(expiresUtc: unknown): number | null {
  if (typeof expiresUtc !== "number" || expiresUtc === 0) return null;
  // Chromium stores cookie expiry as microseconds since 1601-01-01 UTC.
  return Math.floor(expiresUtc / 1000 - 11_644_473_600_000);
}

function readChromiumCookies(dbPath: string): BrowserCookie[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, expires_utc
         FROM cookies
         WHERE host_key LIKE '%x.com' OR host_key LIKE '%twitter.com'`,
      )
      .all();

    return rows.map((row) => {
      const record = row as Record<string, unknown>;
      const name = String(record.name ?? "");
      const value = String(record.value ?? "");
      const encryptedValue = record.encrypted_value;
      const hasEncryptedValue =
        encryptedValue instanceof Uint8Array
          ? encryptedValue.byteLength > 0
          : Buffer.isBuffer(encryptedValue)
            ? encryptedValue.length > 0
            : typeof encryptedValue === "string" && encryptedValue.length > 0;
      if (!value && hasEncryptedValue) {
        throw new XBrowserCookieImportError(
          `Chromium cookie '${name}' is encrypted. Export Cookie header manually or use Firefox/plaintext cookie DB.`,
        );
      }
      return {
        host: String(record.host_key ?? ""),
        name,
        value,
        expiresAtMs: chromiumExpiresAtMs(record.expires_utc),
      };
    });
  } finally {
    db.close();
  }
}

function detectDbKind(dbPath: string): Exclude<BrowserCookieSource, "auto"> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as Record<string, unknown>).name));
    if (tables.includes("moz_cookies")) return "firefox";
    if (tables.includes("cookies")) return "chromium";
    throw new XBrowserCookieImportError(
      "Unsupported browser cookie DB schema.",
    );
  } finally {
    db.close();
  }
}

export function resolveBrowserCookieDbPath(
  options: Pick<BrowserCookieImportOptions, "source" | "dbPath" | "profileDir">,
): { source: Exclude<BrowserCookieSource, "auto">; dbPath: string } {
  if (options.dbPath) {
    const dbPath = resolvePath(options.dbPath);
    return {
      source:
        options.source && options.source !== "auto"
          ? options.source
          : detectDbKind(dbPath),
      dbPath,
    };
  }

  if (!options.profileDir) {
    throw new XBrowserCookieImportError("--db or --profile-dir is required.");
  }

  const source = options.source ?? "auto";
  if (source === "auto") {
    throw new XBrowserCookieImportError(
      "--source is required when using --profile-dir.",
    );
  }

  const profileDir = resolvePath(options.profileDir);
  return {
    source,
    dbPath:
      source === "firefox"
        ? path.join(profileDir, "cookies.sqlite")
        : path.join(profileDir, "Network", "Cookies"),
  };
}

export function readXCookieHeaderFromBrowserDb(
  options: BrowserCookieImportOptions,
): string {
  const resolved = resolveBrowserCookieDbPath(options);
  const cookies =
    resolved.source === "firefox"
      ? readFirefoxCookies(resolved.dbPath)
      : readChromiumCookies(resolved.dbPath);
  return cookieHeaderFromCookies(
    cookies,
    (options.now ?? new Date()).getTime(),
  );
}

export async function importXCookiesFromBrowserDb(
  options: BrowserCookieImportOptions,
): Promise<{ dbPath: string; cookieFile: string }> {
  const resolved = resolveBrowserCookieDbPath(options);
  const cookieHeader = readXCookieHeaderFromBrowserDb({
    ...options,
    source: resolved.source,
    dbPath: resolved.dbPath,
  });
  const saved = await saveXCookieHeader(cookieHeader, {
    cookieFile: options.cookieFile,
    now: options.now,
  });
  return { dbPath: resolved.dbPath, cookieFile: saved.cookieFile };
}
