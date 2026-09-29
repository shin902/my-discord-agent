import { afterEach, describe, expect, it, vi } from "vitest";

const scriptPath = "../scripts/reddit-cookie-refresh.ts";
const { main } = await import(scriptPath);

import { refreshRedditCookies } from "./proxy/reddit-cookie-refresh.js";

vi.mock("./proxy/reddit-cookie-refresh.js", () => ({
  refreshRedditCookies: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe("reddit:refresh command", () => {
  it("runs the host-only refresh helper", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    expect(refreshRedditCookies).toHaveBeenCalledExactlyOnceWith();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("クッキーを更新しました"),
    );
  });
  it("reports failures without leaking browser diagnostics", async () => {
    vi.mocked(refreshRedditCookies).mockRejectedValueOnce(
      new Error("Reddit state is unavailable"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await main();
    expect(process.exitCode).toBe(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("pnpm reddit:login"),
    );
    expect(log.mock.calls.flat().join(" ")).not.toContain(
      "Reddit state is unavailable",
    );
  });
});
