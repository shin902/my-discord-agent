import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronContext } from "../runner.js";
import handler from "./x-cookie-check.js";

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "x-cookie-check-test-"));
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

function makeCtx(settings: Record<string, unknown>): CronContext {
  return {
    id: "x-cookie-check",
    schedule: "0 0 * * *",
    enabled: true,
    appendInbox: vi.fn(async () => undefined),
    client: {} as CronContext["client"],
    settings,
  } as CronContext;
}

async function writeCookieFile(updatedAt: string): Promise<string> {
  const cookieFile = join(tmpDir, "x-cookies.json");
  await writeFile(
    cookieFile,
    JSON.stringify({
      cookieHeader: "auth_token=secret; ct0=csrf",
      csrfToken: "csrf",
      updatedAt,
    }),
    "utf-8",
  );
  return cookieFile;
}

describe("x-cookie-check handler", () => {
  it("有効な cookie なら残り日数をログ出力する", async () => {
    const cookieFile = await writeCookieFile("2026-07-01T00:00:00.000Z");
    const nowMs = Date.parse("2026-07-04T00:00:00.000Z");

    await handler(makeCtx({ cookieFile, nowMs }));

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("残り約4.0日"));
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("期限切れの cookie ならエラーログを出力し例外は投げない", async () => {
    const cookieFile = await writeCookieFile("2026-07-01T00:00:00.000Z");
    const nowMs = Date.parse("2026-07-10T00:00:00.000Z");

    await handler(makeCtx({ cookieFile, nowMs }));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("失効しています"),
    );
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("cookie ファイルが無ければエラーログを出力する", async () => {
    await handler(makeCtx({ cookieFile: join(tmpDir, "missing.json") }));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("失効しています"),
    );
  });
});
