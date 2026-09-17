import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readXCookies, writeXCookiesAtomic } from "./proxy/x-cookie-store.js";

vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: vi.fn() },
}));
vi.mock("./proxy/x-cookie-store.js", () => ({
  readXCookies: vi.fn().mockResolvedValue({ auth_token: "new", ct0: "new" }),
  writeXCookiesAtomic: vi.fn().mockResolvedValue(undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("x:login", () => {
  it("waits for authenticated Home before replacing cookies", async () => {
    const context = new EventEmitter();
    const goto = vi.fn().mockResolvedValue(undefined);
    let reachHome: (() => void) | undefined;
    const waitForURL = vi.fn(
      () => new Promise<void>((resolve) => (reachHome = resolve)),
    );
    Object.assign(context, {
      newPage: vi.fn().mockResolvedValue({ goto, waitForURL }),
    });
    vi.mocked(chromium.launchPersistentContext).mockResolvedValue(
      context as never,
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    const scriptUrl = new URL("../scripts/x-cookie-login.ts", import.meta.url);
    const { main } = (await import(scriptUrl.href)) as {
      main(): Promise<void>;
    };

    const login = main();
    await vi.waitUntil(() => waitForURL.mock.calls.length === 1);
    expect(writeXCookiesAtomic).not.toHaveBeenCalled();

    reachHome?.();
    await vi.waitUntil(
      () => vi.mocked(writeXCookiesAtomic).mock.calls.length === 1,
    );
    expect(readXCookies).toHaveBeenCalledWith(context);
    context.emit("close");
    await login;
  });
});
