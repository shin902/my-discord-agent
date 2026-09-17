import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshXCookies } from "./x-cookie-refresh.js";

vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: vi.fn() },
}));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      killed: false,
      kill: vi.fn(() => {
        child.emit("exit", 0);
        return true;
      }),
    });
    return child;
  }),
}));

let directory: string;
let cookieFile: string;
const page = {
  goto: vi.fn(),
  url: vi.fn(),
  getByTestId: vi.fn(),
};
const waitFor = vi.fn();
const context = { newPage: vi.fn(), cookies: vi.fn(), close: vi.fn() };

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "x-refresh-"));
  cookieFile = join(directory, "twitter-cookies.json");
  await writeFile(cookieFile, "existing credentials", { mode: 0o600 });
  page.goto.mockResolvedValue({ ok: () => true });
  page.url.mockReturnValue("https://x.com/home");
  page.getByTestId.mockReturnValue({ waitFor });
  waitFor.mockResolvedValue(undefined);
  context.newPage.mockResolvedValue(page);
  context.cookies.mockResolvedValue([
    { name: "auth_token", value: "auth" },
    { name: "ct0", value: "csrf" },
    { name: "other", value: "discard" },
  ]);
  context.close.mockResolvedValue(undefined);
  vi.mocked(chromium.launchPersistentContext).mockResolvedValue(
    context as never,
  );
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.useRealTimers();
  vi.resetAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function refresh() {
  const result = refreshXCookies({
    profileDir: join(directory, "profile"),
    cookieFile,
  });
  const observed = result.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(500);
  return observed;
}

it("saves only after successful authenticated Home navigation, atomically at 0600", async () => {
  expect(await refresh()).toBeUndefined();
  expect(page.getByTestId).toHaveBeenCalledWith(
    "SideNav_AccountSwitcher_Button",
  );
  expect(waitFor.mock.invocationCallOrder[0]).toBeLessThan(
    context.cookies.mock.invocationCallOrder[0],
  );
  expect(JSON.parse(await readFile(cookieFile, "utf8"))).toEqual({
    auth_token: "auth",
    ct0: "csrf",
  });
  expect((await stat(cookieFile)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(["twitter-cookies.json"]);
  expect(context.close).toHaveBeenCalledOnce();
});

it.each([
  "no response",
  "429",
  "500",
  "503",
  "login redirect",
  "challenge",
  "foreign Home",
  "missing UI",
  "redirect after UI",
  "missing auth_token",
  "missing ct0",
  "browser error",
  "close failure",
])("rejects %s and preserves the existing file", async (failure) => {
  if (failure === "no response") page.goto.mockResolvedValue(null);
  else if (/^\d+$/.test(failure))
    page.goto.mockResolvedValue({
      ok: () => false,
      status: () => Number(failure),
    });
  else if (failure === "login redirect")
    page.url.mockReturnValue("https://x.com/i/flow/login");
  else if (failure === "challenge")
    page.url.mockReturnValue("https://x.com/account/access");
  else if (failure === "foreign Home")
    page.url.mockReturnValue("https://example.com/home");
  else if (failure === "close failure")
    context.close.mockRejectedValue(new Error("private close failure"));
  else if (failure === "missing UI")
    waitFor.mockRejectedValue(new Error("private page error"));
  else if (failure === "redirect after UI")
    page.url
      .mockReturnValueOnce("https://x.com/home")
      .mockReturnValue("https://x.com/i/flow/login");
  else if (failure.startsWith("missing "))
    context.cookies.mockResolvedValue([
      {
        name: failure === "missing ct0" ? "auth_token" : "ct0",
        value: "stale",
      },
    ]);
  else page.goto.mockRejectedValue(new Error("private browser error"));
  const error = await refresh();
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).not.toContain("private");
  expect(await readFile(cookieFile, "utf8")).toBe("existing credentials");
  expect(await readdir(directory)).toEqual(["twitter-cookies.json"]);
  expect(context.close).toHaveBeenCalledOnce();
});
