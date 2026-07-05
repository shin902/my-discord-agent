import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildStoredXCookies,
  saveXCookieHeader,
  XCookieImportError,
} from "./x-cookie-import.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "x-cookie-import-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("buildStoredXCookies", () => {
  it("Cookie header から ct0 を csrfToken として保存形式を作る", () => {
    const stored = buildStoredXCookies(
      "Cookie: guest_id=guest; auth_token=auth-secret; ct0=csrf-secret",
      new Date("2026-07-05T00:00:00.000Z"),
    );

    expect(stored).toEqual({
      cookieHeader: "guest_id=guest; auth_token=auth-secret; ct0=csrf-secret",
      csrfToken: "csrf-secret",
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
  });

  it("auth_token がないと失敗する", () => {
    expect(() => buildStoredXCookies("ct0=csrf-secret")).toThrow(
      XCookieImportError,
    );
  });

  it("ct0 がないと失敗する", () => {
    expect(() => buildStoredXCookies("auth_token=auth-secret")).toThrow(
      XCookieImportError,
    );
  });
});

describe("saveXCookieHeader", () => {
  it("0600 の data/x-cookies.json 形式で保存する", async () => {
    const cookieFile = join(tmpDir, "x-cookies.json");

    const result = await saveXCookieHeader(
      "auth_token=auth-secret; ct0=csrf-secret",
      {
        cookieFile,
        now: new Date("2026-07-05T00:00:00.000Z"),
      },
    );

    expect(result.cookieFile).toBe(cookieFile);
    const raw = await readFile(cookieFile, "utf-8");
    expect(JSON.parse(raw)).toEqual({
      cookieHeader: "auth_token=auth-secret; ct0=csrf-secret",
      csrfToken: "csrf-secret",
      updatedAt: "2026-07-05T00:00:00.000Z",
    });
    expect((await stat(cookieFile)).mode & 0o777).toBe(0o600);
  });
});
