import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCommand,
  buildGitHubMarkdown,
  buildRedditMarkdown,
  detectService,
  isPrivateAddress,
  parseVtt,
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

  it("github.com/owner/repo/blob/... → web（サブパスは除外）", () => {
    expect(
      detectService(parse("https://github.com/owner/repo/blob/main/file.ts")),
    ).toBe("web");
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

  it("github-repo: GitHub API への curl コマンドを生成する", () => {
    const cmd = buildCommand(
      "github-repo",
      "https://github.com/owner/my-repo",
      out,
    );
    expect(cmd).toContain("api.github.com/repos/owner/my-repo");
    expect(cmd).toContain("curl -sf");
    expect(cmd).toContain(".repo.json");
    expect(cmd).toContain(".readme.md");
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

describe("parseVtt", () => {
  it("インラインタイミングタグ付き行とクリーン行が混在しても重複なく出力する", () => {
    const vtt = `WEBVTT
Kind: captions
Language: ja

00:00:00.000 --> 00:00:03.000 align:start position:0%

おスマ<00:00:00.599><c>です</c><00:00:00.719><c>。</c><00:00:00.919><c>本日</c><00:00:01.280><c>は</c><00:00:01.400><c>です</c><00:00:01.599><c>ね</c><00:00:01.719><c>、</c><00:00:02.120><c>Google</c>
おスマです。本日はですね、Google

00:00:03.000 --> 00:00:07.000 align:start position:0%

IO<00:00:03.080><c>の</c><00:00:03.480><c>イベント</c><00:00:03.919><c>、</c>
IOのイベント、え、そうまとめみたいな
`;
    const result = parseVtt(vtt);
    const lines = result.split("\n");
    // タグが含まれていないこと
    expect(lines.every((l) => !/<\d{2}:\d{2}:\d{2}/.test(l))).toBe(true);
    expect(lines.every((l) => !/<c>/.test(l))).toBe(true);
    // 。の後で改行されていること
    expect(result).toContain("おスマです。\n");
    // 行結合されていること（GoogleIO がくっついて一行になる）
    expect(result).toContain("GoogleIOのイベント、え、そうまとめみたいな");
  });

  it("WEBVTT ヘッダーと空行は除外する", () => {
    const vtt = `WEBVTT
Kind: captions
Language: ja

00:00:01.000 --> 00:00:02.000

こんにちは
`;
    const result = parseVtt(vtt);
    expect(result).toBe("こんにちは");
  });

  it("完全にタグのみの行は出力しない", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:01.000

<00:00:00.000><c>テスト</c>
テスト
`;
    const result = parseVtt(vtt);
    expect(result).toBe("テスト");
  });

  it("本文と同じ行に潰れた cue timing は除去する", () => {
    const vtt = `WEBVTT
Kind: captions
Language: ja

00:11:08.920 --> 00:11:11.310 align:start position:0%

ところを抽出すればどういったことを学習00:11:08.920 --> 00:11:11.310 align:start position:0%00:11:11.310 --> 00:11:11.320 align:start position:0%してるのかというところも抽出できるかと00:11:11.320 --> 00:11:14.069 align:start position:0%
思います。
`;
    const result = parseVtt(vtt);

    expect(result).toContain(
      "ところを抽出すればどういったことを学習してるのかというところも抽出できるかと思います。",
    );
    expect(result).not.toContain("-->");
    expect(result).not.toContain("align:start");
    expect(result).not.toMatch(/\d{2}:\d{2}:\d{2}[.,]\d{3}/);
  });
});

describe("buildGitHubMarkdown パース", () => {
  async function writeJson(data: unknown): Promise<string> {
    const path = join(tmpdir(), `github-test-${Date.now()}.json`);
    await writeFile(path, JSON.stringify(data), "utf-8");
    return path;
  }

  it("正常なリポジトリ JSON → Markdown を生成する", async () => {
    const repoJson = await writeJson({
      full_name: "owner/my-repo",
      description: "テストリポジトリ",
      language: "TypeScript",
      license: { name: "MIT License" },
      stargazers_count: 123,
      forks_count: 10,
      open_issues_count: 5,
      topics: ["typescript", "bot"],
      homepage: "",
      fork: false,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-06-01T00:00:00Z",
    });
    const result = await buildGitHubMarkdown(
      repoJson,
      "/tmp/nonexistent-readme",
    );
    expect(result).toContain("# owner/my-repo");
    expect(result).toContain("テストリポジトリ");
    expect(result).toContain("TypeScript");
    expect(result).toContain("MIT License");
    expect(result).toContain("*(README not found)*");
  });

  it("README ファイルがある場合は含まれる", async () => {
    const repoJson = await writeJson({
      full_name: "owner/repo",
      stargazers_count: 0,
      forks_count: 0,
      open_issues_count: 0,
      fork: false,
    });
    const readmePath = join(tmpdir(), `readme-${Date.now()}.md`);
    await writeFile(readmePath, "# Hello World", "utf-8");
    const result = await buildGitHubMarkdown(repoJson, readmePath);
    expect(result).toContain("## README");
    expect(result).toContain("# Hello World");
  });

  it("無効な JSON → パース失敗メッセージ", async () => {
    const path = join(tmpdir(), `github-invalid-${Date.now()}.json`);
    await writeFile(path, "not json", "utf-8");
    const result = await buildGitHubMarkdown(path, "/tmp/nonexistent");
    expect(result).toContain("JSON パース失敗");
  });

  it("存在しないファイル → 読み込み失敗メッセージ", async () => {
    const result = await buildGitHubMarkdown(
      "/tmp/nonexistent.json",
      "/tmp/nonexistent",
    );
    expect(result).toContain("読み込みに失敗");
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
