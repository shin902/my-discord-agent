import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("reddit cookie login script", () => {
  it("initializes the canonical cookie file after login", async () => {
    const source = await readFile(
      new URL("../scripts/reddit-cookie-login.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      'const COOKIE_FILE = path.join(ROOT, "data/reddit-cookies.json");',
    );
    expect(source).toContain("await ensureRedditCookieFile(COOKIE_FILE);");
  });
});
