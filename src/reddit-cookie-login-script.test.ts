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
    expect(source).toContain("Tool Runtimeを起動し");
    expect(source).toContain("pnpm reddit:refresh");
    expect(source).toContain("host schedulerの reddit-cookie-refresh");
    expect(source).toContain("docs/guides/reddit-cookie-setup.md");
    expect(source).not.toContain("pnpm cron");
  });
});
