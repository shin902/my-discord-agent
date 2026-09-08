import { EventEmitter } from "node:events";
import { lstat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: vi.fn() },
}));
vi.mock("node:fs/promises", () => ({
  lstat: vi.fn(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => vi.restoreAllMocks());

describe("reddit cookie login script", () => {
  it("initializes the canonical cookie file after the login browser closes", async () => {
    const browser = new EventEmitter();
    const goto = vi.fn().mockResolvedValue(undefined);
    const context = Object.assign(browser, {
      newPage: vi.fn().mockResolvedValue({ goto }),
    });
    vi.mocked(chromium.launchPersistentContext).mockResolvedValue(
      context as never,
    );
    vi.mocked(lstat).mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const scriptUrl = new URL(
      "../scripts/reddit-cookie-login.ts",
      import.meta.url,
    );
    const { main } = (await import(scriptUrl.href)) as {
      main(): Promise<void>;
    };

    const login = main();
    await vi.waitUntil(() => browser.listenerCount("close") > 0);

    expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
      fileURLToPath(new URL("../data/reddit-browser-profile", import.meta.url)),
      expect.objectContaining({ headless: false }),
    );
    expect(goto).toHaveBeenCalledWith("https://www.reddit.com/login");
    expect(writeFile).not.toHaveBeenCalled();

    browser.emit("close");
    await login;

    expect(writeFile).toHaveBeenCalledOnce();
    const [cookiePath, contents, options] = vi.mocked(writeFile).mock.calls[0];
    expect(cookiePath).toBe(
      fileURLToPath(new URL("../data/reddit-cookies.json", import.meta.url)),
    );
    expect(JSON.parse(contents as string)).toEqual({
      cookieHeader: "",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(options).toMatchObject({ mode: 0o600, flag: "wx" });
    const output = log.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(output).toContain("Tool Runtime");
    expect(output).toContain("pnpm reddit:refresh");
    expect(output).toContain("host schedulerの reddit-cookie-refresh");
    expect(output).toContain("docs/guides/reddit-cookie-setup.md");
    expect(output).not.toContain("pnpm cron");
  });
});
