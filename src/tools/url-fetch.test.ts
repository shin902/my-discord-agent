import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCommand,
  buildRedditMarkdown,
  detectService,
  isPrivateAddress,
} from "./url-fetch.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.255",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.0.1",
    "::1",
    "fc00::1",
    "fd00::1",
    "fdff::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:192.168.0.1",
  ])("%s → true（ブロック）", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.0",
    "2001:db8::1",
    "::ffff:8.8.8.8",
  ])("%s → false（許可）", (ip) => {
    expect(isPrivateAddress(ip)).toBe(false);
  });
});

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
    expect(detectService(parse("https://github.com/owner/repo"))).toBe(
      "github-repo",
    );
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

describe("buildCommand シェルエスケープ", () => {
  const out = "/workspace/fetched/out.md";

  it("reddit: 通常URL → .json を付与してcurl", () => {
    const cmd = buildCommand(
      "reddit",
      "https://www.reddit.com/r/programming/comments/abc/",
      out,
    );
    expect(cmd).toContain(".json");
    expect(cmd).toContain("curl -sf");
  });

  it("reddit: シングルクォートを含むURLをエスケープする", () => {
    const url = "https://example.com/path?q=it's";
    const cmd = buildCommand("reddit", url, out);
    expect(cmd).not.toContain(`'https://example.com/path?q=it's'`);
    expect(cmd).toContain("'\\''");
  });

  it("github-repo: owner/repo を抽出してgh repo viewを生成", () => {
    const cmd = buildCommand(
      "github-repo",
      "https://github.com/owner/my-repo",
      out,
    );
    expect(cmd).toContain("gh repo view");
    expect(cmd).toContain("owner/my-repo");
  });

  it("github-repo: パスが /owner/repo 未満なら throw", () => {
    expect(() =>
      buildCommand("github-repo", "https://github.com/owner", out),
    ).toThrow("GitHub URL からリポジトリを取得できません");
  });

  it("web: jina.ai 経由でcurl", () => {
    const cmd = buildCommand("web", "https://example.com/article", out);
    expect(cmd).toContain("r.jina.ai");
    expect(cmd).toContain("curl -sf");
  });
});

describe("buildRedditMarkdown パース", () => {
  async function write(data: unknown): Promise<string> {
    const path = join(tmpdir(), `reddit-test-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(data), "utf-8");
    return path;
  }

  it("無効なJSONファイル → パース失敗メッセージ", async () => {
    const path = join(tmpdir(), `reddit-test-invalid-${Date.now()}.json`);
    await writeFile(path, "not json", "utf-8");
    const result = await buildRedditMarkdown(path);
    expect(result).toContain("JSON パース失敗");
  });

  it("存在しないファイル → 読み込み失敗メッセージ", async () => {
    const result = await buildRedditMarkdown("/tmp/nonexistent-file.json");
    expect(result).toContain("読み込みに失敗");
  });

  it("空配列 → 構造解析失敗メッセージ", async () => {
    const path = await write([]);
    const result = await buildRedditMarkdown(path);
    expect(result).toContain("構造を解析できませんでした");
  });

  it("スレッド: data[1]がないとコメントなしで返す", async () => {
    const path = await write([
      {
        data: {
          children: [
            {
              data: {
                title: "テスト投稿",
                subreddit: "test",
                author: "user1",
                score: 100,
                num_comments: 5,
                created_utc: 1700000000,
                selftext: "",
              },
            },
          ],
        },
      },
    ]);
    const result = await buildRedditMarkdown(path);
    expect(result).toContain("テスト投稿");
    expect(result).not.toContain("トップコメント");
  });

  it("スレッド: data[1]にコメントがあれば含まれる", async () => {
    const path = await write([
      {
        data: {
          children: [
            {
              data: {
                title: "テスト投稿",
                subreddit: "test",
                author: "user1",
                score: 100,
                num_comments: 1,
                created_utc: 1700000000,
                selftext: "",
              },
            },
          ],
        },
      },
      {
        data: {
          children: [
            {
              kind: "t1",
              data: { author: "commenter", score: 10, body: "いいコメント" },
            },
          ],
        },
      },
    ]);
    const result = await buildRedditMarkdown(path);
    expect(result).toContain("トップコメント");
    expect(result).toContain("いいコメント");
  });
});
