import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readXCookies, writeXCookiesAtomic } from "./x-cookie-store.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("X cookie store", () => {
  it("requires both credentials and atomically writes only those values", async () => {
    const context = {
      cookies: async () => [
        { name: "auth_token", value: "auth" },
        { name: "ct0", value: "csrf" },
        { name: "other", value: "ignored" },
      ],
    };
    const cookies = await readXCookies(context as never);
    directory = await mkdtemp(join(tmpdir(), "x-cookie-store-"));
    const file = join(directory, "twitter-cookies.json");
    await writeFile(file, "old");
    await writeXCookiesAtomic(file, cookies);

    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      auth_token: "auth",
      ct0: "csrf",
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await expect(
      readXCookies({
        cookies: async () => [{ name: "ct0", value: "csrf" }],
      } as never),
    ).rejects.toThrow("auth_token or ct0");
  });
});
