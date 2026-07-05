import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readXCookieStore,
  XCookieInvalidError,
  XCookieMissingError,
  XCookieStaleError,
} from "./x-cookie-store.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "x-cookie-store-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeCookieFile(value: unknown): Promise<string> {
  const cookieFile = join(tmpDir, "x-cookies.json");
  await writeFile(cookieFile, JSON.stringify(value), "utf-8");
  return cookieFile;
}

describe("readXCookieStore", () => {
  it("data/x-cookies.json 形式の cookieHeader と csrfToken を読む", async () => {
    const updatedAt = "2026-07-01T00:00:00.000Z";
    const cookieFile = await writeCookieFile({
      cookieHeader: "auth_token=secret; ct0=csrf",
      csrfToken: "csrf",
      updatedAt,
    });

    await expect(
      readXCookieStore({ cookieFile, nowMs: Date.parse(updatedAt) }),
    ).resolves.toEqual({
      cookieHeader: "auth_token=secret; ct0=csrf",
      csrfToken: "csrf",
      updatedAt,
    });
  });

  it("cookie ファイルがないと XCookieMissingError", async () => {
    await expect(
      readXCookieStore({ cookieFile: join(tmpDir, "missing.json") }),
    ).rejects.toBeInstanceOf(XCookieMissingError);
  });

  it("必須 field が欠落すると XCookieInvalidError", async () => {
    const cookieFile = await writeCookieFile({
      cookieHeader: "auth_token=secret",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    await expect(readXCookieStore({ cookieFile })).rejects.toBeInstanceOf(
      XCookieInvalidError,
    );
  });

  it("updatedAt が不正だと XCookieInvalidError", async () => {
    const cookieFile = await writeCookieFile({
      cookieHeader: "auth_token=secret; ct0=csrf",
      csrfToken: "csrf",
      updatedAt: "not-a-date",
    });

    await expect(readXCookieStore({ cookieFile })).rejects.toBeInstanceOf(
      XCookieInvalidError,
    );
  });

  it("maxAgeDays を超過すると XCookieStaleError", async () => {
    const cookieFile = await writeCookieFile({
      cookieHeader: "auth_token=secret; ct0=csrf",
      csrfToken: "csrf",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    await expect(
      readXCookieStore({
        cookieFile,
        maxAgeDays: 1,
        nowMs: Date.parse("2026-07-03T00:00:01.000Z"),
      }),
    ).rejects.toBeInstanceOf(XCookieStaleError);
  });
});
