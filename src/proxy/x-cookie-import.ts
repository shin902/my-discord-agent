import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_X_COOKIE_FILE, type StoredXCookies } from "./x-cookie-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "../../");

export class XCookieImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XCookieImportError";
  }
}

export type SaveXCookieHeaderOptions = {
  cookieFile?: string;
  now?: Date;
};

function resolveDataPath(input: string | undefined): string {
  if (!input) return DEFAULT_X_COOKIE_FILE;
  return path.isAbsolute(input) ? input : path.resolve(ROOT, input);
}

function normalizeCookieHeader(input: string): string {
  return input.trim().replace(/^cookie\s*:\s*/i, "").replace(/[\r\n]+/g, "").trim();
}

function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (name && value) cookies.set(name, value);
  }
  return cookies;
}

export function buildStoredXCookies(
  rawCookieHeader: string,
  now: Date = new Date(),
): StoredXCookies {
  const cookieHeader = normalizeCookieHeader(rawCookieHeader);
  if (!cookieHeader) {
    throw new XCookieImportError("Cookie header is empty.");
  }

  const cookies = parseCookieHeader(cookieHeader);
  if (!cookies.get("auth_token")) {
    throw new XCookieImportError("X auth_token cookie is missing.");
  }

  const csrfToken = cookies.get("ct0");
  if (!csrfToken) {
    throw new XCookieImportError("X ct0 cookie is missing.");
  }

  return {
    cookieHeader,
    csrfToken,
    updatedAt: now.toISOString(),
  };
}

export async function saveXCookieHeader(
  rawCookieHeader: string,
  options: SaveXCookieHeaderOptions = {},
): Promise<{ cookieFile: string; stored: StoredXCookies }> {
  const cookieFile = resolveDataPath(options.cookieFile);
  const stored = buildStoredXCookies(rawCookieHeader, options.now);

  await mkdir(path.dirname(cookieFile), { recursive: true, mode: 0o700 });
  await writeFile(cookieFile, JSON.stringify(stored, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await chmod(cookieFile, 0o600);

  return { cookieFile, stored };
}
