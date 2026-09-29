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
import type { BrowserContext } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readAuthenticatedRedditCookies,
  writeRedditCookiesAtomic,
} from "./reddit-cookie-refresh.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function browser(
  status = 200,
  url = "https://www.reddit.com/",
  identity: unknown = { kind: "t2", data: { name: "tester" } },
  cookies = [{ name: "reddit_session", value: "private" }],
  challenge = false,
) {
  const page = {
    goto: vi.fn().mockResolvedValue({ ok: () => status < 400 }),
    url: () => url,
    locator: vi.fn().mockReturnValue({
      waitFor: challenge
        ? vi.fn().mockRejectedValue(new Error("challenge"))
        : vi.fn(),
    }),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    request: {
      get: vi.fn().mockResolvedValue({
        ok: () => status < 400,
        json: async () => identity,
      }),
    },
    cookies: vi.fn().mockResolvedValue(cookies),
  } as unknown as BrowserContext;
  return context;
}

describe("Reddit host refresh", () => {
  it("requires a successful page, authenticated identity and session cookie", async () => {
    await expect(readAuthenticatedRedditCookies(browser())).resolves.toBe(
      "reddit_session=private",
    );
    for (const context of [
      browser(429),
      browser(503),
      browser(200, "https://www.reddit.com/login/"),
      browser(200, "https://www.reddit.com/", {}),
      browser(200, "https://www.reddit.com/", undefined, undefined, true),
      browser(
        200,
        "https://www.reddit.com/",
        { kind: "t2", data: { name: "tester" } },
        [{ name: "challenge", value: "1" }],
      ),
    ])
      await expect(readAuthenticatedRedditCookies(context)).rejects.toThrow();

    const apiError = browser();
    vi.spyOn(apiError.request, "get").mockResolvedValue({
      ok: () => false,
    } as never);
    await expect(readAuthenticatedRedditCookies(apiError)).rejects.toThrow();
  });

  it("replaces cookies with mode 0600 and keeps the old file if replacement fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reddit-refresh-"));
    directories.push(dir);
    const cookieFile = join(dir, "cookies.json");
    await writeFile(cookieFile, "old", { mode: 0o600 });
    await expect(
      writeRedditCookiesAtomic(join(dir, "missing", "file.json"), "session=ok"),
    ).resolves.toBeUndefined();
    await writeRedditCookiesAtomic(cookieFile, "reddit_session=new");
    expect(JSON.parse(await readFile(cookieFile, "utf8"))).toMatchObject({
      cookieHeader: "reddit_session=new",
    });
    expect((await stat(cookieFile)).mode & 0o777).toBe(0o600);
    const before = await readFile(cookieFile, "utf8");
    await expect(
      writeRedditCookiesAtomic(dir, "reddit_session=bad"),
    ).rejects.toThrow();
    expect(await readFile(cookieFile, "utf8")).toBe(before);
    expect(
      (await readdir(dir)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
