import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readXCookies, writeXCookiesAtomic } from "./proxy/x-cookie-store.js";

vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: vi.fn() },
}));
vi.mock("./proxy/x-cookie-store.js", () => ({
  readXCookies: vi.fn(),
  writeXCookiesAtomic: vi.fn(),
}));

let context: EventEmitter & {
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
const page = {
  goto: vi.fn(),
  waitForURL: vi.fn(),
  url: vi.fn(),
  getByTestId: vi.fn(),
};
const waitFor = vi.fn();
const scriptUrl = new URL("../scripts/x-cookie-login.ts", import.meta.url);
const { main } = (await import(scriptUrl.href)) as { main(): Promise<void> };

beforeEach(() => {
  context = Object.assign(new EventEmitter(), {
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(chromium.launchPersistentContext).mockResolvedValue(
    context as never,
  );
  page.goto.mockResolvedValue({ ok: () => true });
  page.waitForURL.mockResolvedValue(undefined);
  page.url.mockReturnValue("https://x.com/home");
  page.getByTestId.mockReturnValue({ waitFor });
  waitFor.mockResolvedValue(undefined);
  vi.mocked(readXCookies).mockResolvedValue({
    auth_token: "stale",
    ct0: "stale",
  });
  vi.mocked(writeXCookiesAtomic).mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("x:login", () => {
  it("ignores stale cookies until Home and authenticated UI, retaining close during save", async () => {
    let reachHome: (() => void) | undefined;
    page.waitForURL.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          reachHome = resolve;
        }),
    );
    let authenticate: (() => void) | undefined;
    waitFor.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          authenticate = resolve;
        }),
    );
    vi.mocked(writeXCookiesAtomic).mockImplementation(async () => {
      context.emit("close");
    });
    const login = main();
    await vi.waitUntil(() => page.waitForURL.mock.calls.length === 1);
    expect(readXCookies).not.toHaveBeenCalled();
    reachHome?.();
    await vi.waitUntil(() => waitFor.mock.calls.length === 1);
    expect(writeXCookiesAtomic).not.toHaveBeenCalled();
    vi.mocked(readXCookies).mockResolvedValue({
      auth_token: "new",
      ct0: "new",
    });
    authenticate?.();
    await login;
    expect(writeXCookiesAtomic).toHaveBeenCalledWith(
      expect.stringMatching(/data\/twitter-cookies.json$/),
      { auth_token: "new", ct0: "new" },
    );
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("registers close before creating a page and fails without saving on early close", async () => {
    context.newPage.mockImplementation(async () => {
      expect(context.listenerCount("close")).toBe(1);
      context.emit("close");
      throw new Error("context closed");
    });
    await expect(main()).rejects.toThrow("context closed");
    expect(writeXCookiesAtomic).not.toHaveBeenCalled();
  });

  it.each([
    "missing UI",
    "HTTP error",
  ])("does not save on %s at Home", async (failure) => {
    if (failure === "missing UI")
      waitFor.mockRejectedValue(new Error("no authenticated UI"));
    else page.goto.mockResolvedValue({ ok: () => false });
    await expect(main()).rejects.toThrow();
    expect(readXCookies).not.toHaveBeenCalled();
    expect(writeXCookiesAtomic).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
