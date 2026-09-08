import { afterEach, describe, expect, it, vi } from "vitest";

const scriptPath = "../scripts/reddit-cookie-refresh.ts";
const { main } = await import(scriptPath);

import { refreshRedditCookiesInRuntime } from "./runtime/tool-runtime-client.js";

vi.mock("./runtime/tool-runtime-client.js", () => ({
  refreshRedditCookiesInRuntime: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe("reddit:refresh command", () => {
  it("runs the host-only one-shot maintenance launcher", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    expect(refreshRedditCookiesInRuntime).toHaveBeenCalledExactlyOnceWith();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("クッキーを更新しました"),
    );
  });
  it("reports launcher errors with a nonzero exit code", async () => {
    vi.mocked(refreshRedditCookiesInRuntime).mockRejectedValueOnce(
      new Error("Reddit state is unavailable"),
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await main();
    expect(process.exitCode).toBe(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Reddit state is unavailable"),
    );
  });
});
