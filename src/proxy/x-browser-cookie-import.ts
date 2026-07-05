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
  path: string;
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

const X_REQUEST_HOST = "x.com";
const X_REQUEST_PATH = "/";

function normalizedCookieDomain(host: string): string {
  return host.toLowerCase().replace(/^\./, "");
}

function effectiveCookiePath(cookiePath: string): string {
  return cookiePath.startsWith("/") ? cookiePath : "/";
}

function cookieMatchesXRequest(cookie: BrowserCookie): boolean {
  if (normalizedCookieDomain(cookie.host) !== X_REQUEST_HOST) return false;

  const cookiePath = effectiveCookiePath(cookie.path);
  return (
    X_REQUEST_PATH === cookiePath ||
    (X_REQUEST_PATH.startsWith(cookiePath) &&
      (cookiePath.endsWith("/") ||
        X_REQUEST_PATH.charAt(cookiePath.length) === "/"))
  );
}

function cookieScopeKey(cookie: BrowserCookie): string {
  const hostOnly = cookie.host.startsWith(".") ? "domain" : "host";
  return `${hostOnly}:${normalizedCookieDomain(cookie.host)}:${effectiveCookiePath(cookie.path)}`;
}

function credentialScopePriority(cookie: BrowserCookie): number {
  return cookie.host.startsWith(".") ? 1 : 0;
}

function isExpired(cookie: BrowserCookie, nowMs: number): boolean {
  return cookie.expiresAtMs !== null && cookie.expiresAtMs <= nowMs;
}

function cookieHeaderFromCookies(
  cookies: BrowserCookie[],
  nowMs: number,
): string {
  const currentCookies = cookies.filter(
    (cookie) => cookieMatchesXRequest(cookie) && !isExpired(cookie, nowMs),
  );
  const authTokens = currentCookies.filter(
    (cookie) => cookie.name === "auth_token",
  );
  if (authTokens.length === 0) {
    throw new XBrowserCookieImportError(
      "X auth_token cookie was not found in browser DB.",
    );
  }
  const csrfTokens = currentCookies.filter((cookie) => cookie.name === "ct0");
  if (csrfTokens.length === 0) {
    throw new XBrowserCookieImportError(
      "X ct0 cookie was not found in browser DB.",
    );
  }

  const credentialScopes = new Map<
    string,
    { authTokens: BrowserCookie[]; csrfTokens: BrowserCookie[] }
  >();
  for (const authToken of authTokens) {
    const key = cookieScopeKey(authToken);
    const scope = credentialScopes.get(key) ?? {
      authTokens: [],
      csrfTokens: [],
    };
    scope.authTokens.push(authToken);
    credentialScopes.set(key, scope);
  }
  for (const csrfToken of csrfTokens) {
    const key = cookieScopeKey(csrfToken);
    const scope = credentialScopes.get(key) ?? {
      authTokens: [],
      csrfTokens: [],
    };
    scope.csrfTokens.push(csrfToken);
    credentialScopes.set(key, scope);
  }

  const credentialPair = [...credentialScopes.values()]
    .filter(
      (scope) => scope.authTokens.length > 0 && scope.csrfTokens.length > 0,
    )
    .sort(
      (a, b) =>
        credentialScopePriority(a.authTokens[0]) -
        credentialScopePriority(b.authTokens[0]),
    )[0];
  if (!credentialPair) {
    throw new XBrowserCookieImportError(
      "X auth_token and ct0 cookies were not found in the same request scope.",
    );
  }

  const uniqueAuthValues = new Set(
    credentialPair.authTokens.map((cookie) => cookie.value),
  );
  const uniqueCsrfValues = new Set(
    credentialPair.csrfTokens.map((cookie) => cookie.value),
  );
  if (uniqueAuthValues.size > 1 || uniqueCsrfValues.size > 1) {
    throw new XBrowserCookieImportError(
      "Multiple X authentication cookie values were found in the same request scope.",
    );
  }

  const selectedCredentials = [
    credentialPair.authTokens[0],
    credentialPair.csrfTokens[0],
  ];
  return currentCookies
    .filter((cookie) => cookie.name !== "auth_token" && cookie.name !== "ct0")
    .concat(selectedCredentials)
    .sort((a, b) =>
      `${a.host}:${a.path}:${a.name}`.localeCompare(
        `${b.host}:${b.path}:${b.name}`,
      ),
    )
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

function readFirefoxCookies(dbPath: string): BrowserCookie[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return db
      .prepare(
        `SELECT host, path, name, value, expiry
         FROM moz_cookies
         WHERE lower(host) IN ('x.com', '.x.com')`,
      )
      .all()
      .map((row) => {
        const record = row as Record<string, unknown>;
        return {
          host: String(record.host ?? ""),
          path: String(record.path ?? ""),
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
        `SELECT host_key, path, name, value, encrypted_value, expires_utc
         FROM cookies
         WHERE lower(host_key) IN ('x.com', '.x.com')`,
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
        path: String(record.path ?? ""),
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
