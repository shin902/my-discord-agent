import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureRedditCookieFile,
  type RedditCookieFileSystem,
} from "./proxy/reddit-cookie-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ensureRedditCookieFile", () => {
  it("creates a regular stale cookie file when the bind source is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reddit-cookie-login-"));
    temporaryDirectories.push(directory);
    const cookieFile = join(directory, "nested", "reddit-cookies.json");

    await ensureRedditCookieFile(cookieFile);

    const contents = JSON.parse(await readFile(cookieFile, "utf8")) as {
      cookieHeader: string;
      updatedAt: string;
    };
    expect(contents.cookieHeader).toBe("");
    expect(contents.updatedAt).toBe("1970-01-01T00:00:00.000Z");
    expect((await stat(cookieFile)).isFile()).toBe(true);
    expect((await stat(cookieFile)).mode & 0o777).toBe(0o600);
  });

  it("rejects an existing directory without replacing it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reddit-cookie-login-"));
    temporaryDirectories.push(directory);
    const cookiePath = join(directory, "reddit-cookies.json");
    await mkdir(cookiePath);

    await expect(ensureRedditCookieFile(cookiePath)).rejects.toThrow(
      `Reddit cookie path is not a regular file: ${cookiePath}`,
    );
    expect((await stat(cookiePath)).isDirectory()).toBe(true);
  });

  it("rejects a directory created between the initial check and exclusive write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reddit-cookie-login-"));
    temporaryDirectories.push(directory);
    const cookiePath = join(directory, "reddit-cookies.json");
    const directoryStat = await stat(directory);
    const lstat = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
      )
      .mockResolvedValueOnce(directoryStat);
    const writeFile = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("already exists"), { code: "EEXIST" }),
      );
    const fileSystem = {
      lstat,
      mkdir: vi.fn(),
      writeFile,
    } as unknown as RedditCookieFileSystem;

    await expect(
      ensureRedditCookieFile(cookiePath, fileSystem),
    ).rejects.toThrow(
      `Reddit cookie path is not a regular file: ${cookiePath}`,
    );
    expect(lstat).toHaveBeenCalledTimes(2);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("does not replace an existing cookie file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reddit-cookie-login-"));
    temporaryDirectories.push(directory);
    const cookieFile = join(directory, "reddit-cookies.json");
    const existing = JSON.stringify({
      cookieHeader: "session=existing",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(cookieFile, existing, { mode: 0o600 });

    await ensureRedditCookieFile(cookieFile);

    expect(await readFile(cookieFile, "utf8")).toBe(existing);
    await access(cookieFile);
  });
});
