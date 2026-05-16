import { describe, expect, it } from "vitest";
import { detectService } from "./url-fetch.js";

describe("detectService", () => {
  const parse = (url: string) => new URL(url);

  it("youtube.com → youtube", () => {
    expect(detectService(parse("https://www.youtube.com/watch?v=abc"))).toBe(
      "youtube",
    );
  });

  it("youtu.be → youtube", () => {
    expect(detectService(parse("https://youtu.be/abc"))).toBe("youtube");
  });

  it("github.com/owner/repo → github-repo", () => {
    expect(
      detectService(parse("https://github.com/owner/repo")),
    ).toBe("github-repo");
  });

  it("github.com/owner/repo/blob/... → github-repo", () => {
    expect(
      detectService(parse("https://github.com/owner/repo/blob/main/file.ts")),
    ).toBe("github-repo");
  });

  it("github.com/owner のみ → web（リポジトリ未満）", () => {
    expect(detectService(parse("https://github.com/owner"))).toBe("web");
  });

  it("reddit.com → reddit", () => {
    expect(
      detectService(
        parse("https://www.reddit.com/r/programming/comments/abc123/"),
      ),
    ).toBe("reddit");
  });

  it(".xml URL → rss", () => {
    expect(detectService(parse("https://example.com/atom.xml"))).toBe("rss");
  });

  it("/feed パス → rss", () => {
    expect(detectService(parse("https://example.com/feed"))).toBe("rss");
  });

  it("一般URL → web", () => {
    expect(detectService(parse("https://example.com/article"))).toBe("web");
  });
});
