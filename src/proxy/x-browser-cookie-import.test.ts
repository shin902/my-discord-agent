import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  importXCookiesFromBrowserDb,
  readXCookieHeaderFromBrowserDb,
  XBrowserCookieImportError,
} from "./x-browser-cookie-import.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "x-browser-cookie-import-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function createFirefoxCookieDb(rows: Array<Record<string, unknown>>): string {
  const dbPath = join(tmpDir, "cookies.sqlite");
  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE moz_cookies (
        host TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        expiry INTEGER NOT NULL
      )`,
    );
    const insert = db.prepare(
      "INSERT INTO moz_cookies (host, name, value, expiry) VALUES (@host, @name, @value, @expiry)",
    );
    for (const row of rows) insert.run(row);
  } finally {
    db.close();
  }
  return dbPath;
}

function chromiumExpiresUtc(iso: string): number {
  return (Date.parse(iso) + 11_644_473_600_000) * 1000;
}

function createChromiumCookieDb(rows: Array<Record<string, unknown>>): string {
  const dbPath = join(tmpDir, "Cookies");
  const db = new Database(dbPath);
  try {
    db.exec(
      `CREATE TABLE cookies (
        host_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        encrypted_value BLOB NOT NULL,
        expires_utc INTEGER NOT NULL
      )`,
    );
    const insert = db.prepare(
      "INSERT INTO cookies (host_key, name, value, encrypted_value, expires_utc) VALUES (@host_key, @name, @value, @encrypted_value, @expires_utc)",
    );
    for (const row of rows) insert.run(row);
  } finally {
    db.close();
  }
  return dbPath;
}

describe("readXCookieHeaderFromBrowserDb", () => {
  it("Firefox cookies.sqlite から X Cookie header を作る", () => {
    const dbPath = createFirefoxCookieDb([
      {
        host: ".x.com",
        name: "auth_token",
        value: "auth-secret",
        expiry: 1_900_000_000,
      },
      {
        host: ".x.com",
        name: "ct0",
        value: "csrf-secret",
        expiry: 1_900_000_000,
      },
      {
        host: ".example.com",
        name: "auth_token",
        value: "ignore",
        expiry: 1_900_000_000,
      },
      {
        host: ".twitter.com",
        name: "guest_id",
        value: "guest",
        expiry: 1_900_000_000,
      },
    ]);

    const header = readXCookieHeaderFromBrowserDb({
      dbPath,
      source: "firefox",
      now: new Date("2026-07-05T00:00:00.000Z"),
    });

    expect(header).toContain("auth_token=auth-secret");
    expect(header).toContain("ct0=csrf-secret");
    expect(header).toContain("guest_id=guest");
    expect(header).not.toContain("ignore");
  });

  it("db schema から Firefox を auto detect する", () => {
    const dbPath = createFirefoxCookieDb([
      {
        host: ".x.com",
        name: "auth_token",
        value: "auth-secret",
        expiry: 1_900_000_000,
      },
      {
        host: ".x.com",
        name: "ct0",
        value: "csrf-secret",
        expiry: 1_900_000_000,
      },
    ]);

    expect(readXCookieHeaderFromBrowserDb({ dbPath })).toContain(
      "auth_token=auth-secret",
    );
  });

  it("Chromium plaintext Cookies DB から X Cookie header を作る", () => {
    const dbPath = createChromiumCookieDb([
      {
        host_key: ".x.com",
        name: "auth_token",
        value: "auth-secret",
        encrypted_value: Buffer.alloc(0),
        expires_utc: chromiumExpiresUtc("2030-01-01T00:00:00.000Z"),
      },
      {
        host_key: ".x.com",
        name: "ct0",
        value: "csrf-secret",
        encrypted_value: Buffer.alloc(0),
        expires_utc: chromiumExpiresUtc("2030-01-01T00:00:00.000Z"),
      },
    ]);

    const header = readXCookieHeaderFromBrowserDb({
      dbPath,
      source: "chromium",
      now: new Date("2026-07-05T00:00:00.000Z"),
    });

    expect(header).toContain("auth_token=auth-secret");
    expect(header).toContain("ct0=csrf-secret");
  });

  it("Chromium encrypted cookie は復号せずに失敗する", () => {
    const dbPath = createChromiumCookieDb([
      {
        host_key: ".x.com",
        name: "auth_token",
        value: "",
        encrypted_value: Buffer.from("encrypted"),
        expires_utc: chromiumExpiresUtc("2030-01-01T00:00:00.000Z"),
      },
      {
        host_key: ".x.com",
        name: "ct0",
        value: "csrf-secret",
        encrypted_value: Buffer.alloc(0),
        expires_utc: chromiumExpiresUtc("2030-01-01T00:00:00.000Z"),
      },
    ]);

    expect(() =>
      readXCookieHeaderFromBrowserDb({ dbPath, source: "chromium" }),
    ).toThrow(XBrowserCookieImportError);
  });

  it("期限切れ cookie は使わない", () => {
    const dbPath = createFirefoxCookieDb([
      { host: ".x.com", name: "auth_token", value: "auth-secret", expiry: 1 },
      {
        host: ".x.com",
        name: "ct0",
        value: "csrf-secret",
        expiry: 1_900_000_000,
      },
    ]);

    expect(() =>
      readXCookieHeaderFromBrowserDb({
        dbPath,
        source: "firefox",
        now: new Date("2026-07-05T00:00:00.000Z"),
      }),
    ).toThrow("auth_token");
  });
});

describe("importXCookiesFromBrowserDb", () => {
  it("ブラウザDBから data/x-cookies.json 形式で保存する", async () => {
    const dbPath = createFirefoxCookieDb([
      {
        host: ".x.com",
        name: "auth_token",
        value: "auth-secret",
        expiry: 1_900_000_000,
      },
      {
        host: ".x.com",
        name: "ct0",
        value: "csrf-secret",
        expiry: 1_900_000_000,
      },
    ]);
    const cookieFile = join(tmpDir, "x-cookies.json");

    await importXCookiesFromBrowserDb({
      dbPath,
      cookieFile,
      now: new Date("2026-07-05T00:00:00.000Z"),
    });

    expect(JSON.parse(await readFile(cookieFile, "utf-8"))).toEqual({
      cookieHeader: "auth_token=auth-secret; ct0=csrf-secret",
      csrfToken: "csrf-secret",
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
  });
});
