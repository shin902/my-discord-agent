import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import parityCases from "./__fixtures__/agent-reach/parity-cases.json" with {
  type: "json",
};
import type { FxPost } from "./agent-reach.js";
import {
  agentReachTool,
  buildCommand,
  buildGitHubMarkdown,
  detectService,
  fetchFxPost,
  formatFxPost,
  formatHttpError,
  formatRedditMarkdown,
  getHttpErrorBodyPath,
  hasFxContent,
  normalizeUrl,
  parseHttpStatus,
  parseVtt,
  parseXStatus,
  readLimitedJson,
} from "./agent-reach.js";

const dnsLookupMock = vi.hoisted(() =>
  vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
);
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));

const execFileAsync = promisify(execFile);

describe("normalizeUrl", () => {
  it("意味のある query を保持し fragment だけを除去する", () => {
    expect(
      normalizeUrl(
        "https://example.com/article?id=42&utm_source=discord#section",
      ),
    ).toBe("https://example.com/article?id=42&utm_source=discord");
  });

  it("YouTube の query も保持し fragment だけを除去する", () => {
    expect(
      normalizeUrl("https://www.youtube.com/watch?v=abc&t=30#chapter"),
    ).toBe("https://www.youtube.com/watch?v=abc&t=30");
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

  it("old.reddit.com → reddit", () => {
    expect(detectService(parse("https://old.reddit.com/r/programming/"))).toBe(
      "reddit",
    );
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

  it("x.com/user/status/123 → x-twitter", () => {
    expect(detectService(parse("https://x.com/user/status/123456789"))).toBe(
      "x-twitter",
    );
  });

  it("twitter.com/user/status/456 → x-twitter", () => {
    expect(detectService(parse("https://twitter.com/user/status/456"))).toBe(
      "x-twitter",
    );
  });

  it("www.x.com/user/status/789 → x-twitter（www. strip確認）", () => {
    expect(detectService(parse("https://www.x.com/user/status/789"))).toBe(
      "x-twitter",
    );
  });

  it("x.com/i/article/123 → x-article", () => {
    expect(detectService(parse("https://x.com/i/article/123"))).toBe(
      "x-article",
    );
  });

  it("twitter.com/user/article/456 → x-article", () => {
    expect(detectService(parse("https://twitter.com/user/article/456"))).toBe(
      "x-article",
    );
  });

  it("Article 判定は path 全体一致のみ（余分なサブパスは web）", () => {
    expect(detectService(parse("https://x.com/i/article/123/extra"))).toBe(
      "web",
    );
  });

  it("Article 判定を rss/web より優先する", () => {
    expect(detectService(parse("https://x.com/feed/article/123"))).toBe(
      "x-article",
    );
  });

  it("x.com/user/status/123/extra → web（部分一致しない）", () => {
    expect(detectService(parse("https://x.com/user/status/123/extra"))).toBe(
      "web",
    );
  });

  it("x.com/user（statusなし）→ web", () => {
    expect(detectService(parse("https://x.com/user"))).toBe("web");
  });
});

describe("shared agent-reach parity fixtures", () => {
  it.each(
    parityCases.urlCases,
  )("$name: URL normalization and service detection agree", ({
    input,
    normalized,
    service,
  }) => {
    expect(normalizeUrl(input)).toBe(normalized);
    expect(detectService(new URL(normalized))).toBe(service);
  });

  it.each([
    {
      name: "X post",
      payload: parityCases.xPost.payload,
      expectedOutput: parityCases.xPost.expectedOutput,
    },
    parityCases.xArticle,
    parityCases.previewOnly,
    ...parityCases.formattedCases,
  ])("$name formatter matches the shared fixture", ({
    payload,
    expectedOutput,
  }) => {
    expect(formatFxPost(payload as unknown as FxPost)).toBe(expectedOutput);
  });

  it.each(
    parityCases.errorCases,
  )("$name: tool exposes the canonical error category", async ({
    url,
    toolMessage,
  }) => {
    await expect(
      agentReachTool.execute("parity", { url }, undefined, undefined),
    ).rejects.toThrow(toolMessage);
  });
});

describe("FxTwitter JSON helpers", () => {
  it("readLimitedJson は JSON をサイズ制限付きで読む", async () => {
    const data = await readLimitedJson(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
      100,
    );
    expect(data).toEqual({ ok: true });
  });

  it("readLimitedJson は非 JSON と上限超過を拒否する", async () => {
    await expect(
      readLimitedJson(
        new Response("hello", { headers: { "content-type": "text/plain" } }),
        100,
      ),
    ).rejects.toThrow("non-JSON");

    await expect(
      readLimitedJson(
        new Response(JSON.stringify({ body: "x".repeat(200) }), {
          headers: { "content-type": "application/json" },
        }),
        50,
      ),
    ).rejects.toThrow("too large");
  });
});

describe("buildCommand シェルエスケープ", () => {
  const out = "/workspace/fetched/out.md";

  it("youtube: 原語字幕だけを要求し、字幕取得失敗を握りつぶさない", () => {
    const cmd = buildCommand("youtube", parityCases.youtube.url, out);
    expect(cmd).toContain(
      `--write-auto-subs --sub-langs '${parityCases.youtube.originalSubtitleSelector}' --skip-download`,
    );
    expect(cmd).not.toContain(
      `--sub-langs '${parityCases.youtube.translatedSubtitleSelector}'`,
    );
    expect(cmd).not.toContain("--sub-lang ja,en");
    expect(cmd).not.toContain("2>&1 || true");
    expect(cmd).toContain("> /dev/null");
  });

  it("github-repo: GitHub API への curl コマンドを生成する", () => {
    const cmd = buildCommand(
      "github-repo",
      "https://github.com/owner/my-repo",
      out,
    );
    expect(cmd).toContain("api.github.com/repos/owner/my-repo");
    expect(cmd).toContain("curl -sS");
    expect(cmd).toContain("-w '%{http_code}'");
    expect(cmd).toContain(".repo.json");
    expect(cmd).toContain(".readme.md");
  });

  it("web: 意味のある query を jina.ai への初回取得に渡す", () => {
    const cmd = buildCommand(
      "web",
      normalizeUrl("https://example.com/article?id=42#section"),
      out,
    );
    expect(cmd).toContain(
      "https://r.jina.ai/https://example.com/article?id=42",
    );
    expect(cmd).toContain("curl -sS");
    expect(cmd).toContain("-w '%{http_code}'");
  });
});

describe("YouTube yt-dlp字幕取得", () => {
  it("fake yt-dlp に原語セレクターを渡し、字幕なしは成功扱いにする", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "agent-reach-ts-ytdlp-"));
    try {
      const binDir = join(testDir, "bin");
      const argsLog = join(testDir, "yt-dlp-args.log");
      const ytDlp = join(binDir, "yt-dlp");
      await mkdir(binDir);
      await writeFile(
        ytDlp,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$AGENT_REACH_YTDLP_ARGS"
if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"fixture","chapters":[]}'
fi
`,
        "utf8",
      );
      await chmod(ytDlp, 0o755);

      await expect(
        execFileAsync(
          "bash",
          [
            "-c",
            buildCommand(
              "youtube",
              parityCases.youtube.url,
              join(testDir, "youtube.md"),
            ),
          ],
          {
            env: {
              ...process.env,
              AGENT_REACH_YTDLP_ARGS: argsLog,
              PATH: `${binDir}:${process.env.PATH ?? ""}`,
            },
          },
        ),
      ).resolves.toBeDefined();

      const invocations = (await readFile(argsLog, "utf8")).trim().split("\n");
      expect(invocations).toHaveLength(2);
      expect(invocations[1]).toContain(
        `--write-auto-subs --sub-langs ${parityCases.youtube.originalSubtitleSelector}`,
      );
      expect(invocations[1]).not.toContain(
        parityCases.youtube.translatedSubtitleSelector,
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("字幕取得のstderrと終了失敗を呼び出し元へ伝える", async () => {
    const testDir = await mkdtemp(
      join(tmpdir(), "agent-reach-ts-ytdlp-error-"),
    );
    try {
      const binDir = join(testDir, "bin");
      const ytDlp = join(binDir, "yt-dlp");
      await mkdir(binDir);
      await writeFile(
        ytDlp,
        `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --dump-json "* ]]; then
  printf '%s\\n' '{"title":"fixture","chapters":[]}'
  exit 0
fi
printf '%s\\n' '${parityCases.youtube.retrievalError}' >&2
exit 1
`,
        "utf8",
      );
      await chmod(ytDlp, 0o755);

      await expect(
        execFileAsync(
          "bash",
          [
            "-c",
            buildCommand(
              "youtube",
              parityCases.youtube.url,
              join(testDir, "youtube.md"),
            ),
          ],
          {
            env: {
              ...process.env,
              PATH: `${binDir}:${process.env.PATH ?? ""}`,
            },
          },
        ),
      ).rejects.toMatchObject({
        stderr: expect.stringContaining(parityCases.youtube.retrievalError),
      });
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

describe("parseHttpStatus", () => {
  it("正常なステータスコード文字列をパースする", () => {
    expect(parseHttpStatus("200")).toBe(200);
    expect(parseHttpStatus("404\n")).toBe(404);
    expect(parseHttpStatus("  500  ")).toBe(500);
  });

  it("数値でない場合は null を返す", () => {
    expect(parseHttpStatus("")).toBeNull();
    expect(parseHttpStatus("not-a-status")).toBeNull();
  });

  it("0 や 000（curlが応答を受け取れなかった場合）は null を返す", () => {
    expect(parseHttpStatus("0")).toBeNull();
    expect(parseHttpStatus("000")).toBeNull();
  });
});

describe("getHttpErrorBodyPath", () => {
  const absPath = "/workspace/fetched/web-abcd1234.md";

  it("github-repo は {base}.repo.json を返す", () => {
    expect(getHttpErrorBodyPath("github-repo", absPath)).toBe(
      "/workspace/fetched/web-abcd1234.repo.json",
    );
  });

  it("web は absPath をそのまま返す", () => {
    expect(getHttpErrorBodyPath("web", absPath)).toBe(absPath);
  });
});

describe("formatHttpError", () => {
  it("ステータス・URL・本文を含むメッセージを組み立てる", () => {
    const msg = formatHttpError(
      404,
      "https://example.com/missing",
      "Not Found",
    );
    expect(msg).toContain("HTTPエラー 404");
    expect(msg).toContain("https://example.com/missing");
    expect(msg).toContain("Not Found");
  });

  it("本文が500文字を超える場合は切り詰める", () => {
    const body = "x".repeat(1000);
    const msg = formatHttpError(500, "https://example.com", body);
    expect(msg).toContain("x".repeat(500));
    expect(msg).not.toContain("x".repeat(501));
  });

  it("本文が空でもエラーにならない", () => {
    const msg = formatHttpError(400, "https://example.com", "");
    expect(msg).toBe("HTTPエラー 400 (https://example.com)");
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
    // cue 間に区切りを保って行結合されていること
    expect(result).toContain("Google IOのイベント、え、そうまとめみたいな");
  });

  it("英語字幕の cue 間にスペースを保持する", () => {
    const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000

Hello world

00:00:02.000 --> 00:00:04.000

This continues
`;

    expect(parseVtt(vtt)).toBe("Hello world This continues");
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
      "ところを抽出すればどういったことを学習してるのかというところも抽出できるかと 思います。",
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

describe("formatRedditMarkdown", () => {
  it("空配列 → 構造解析失敗メッセージ", () => {
    const result = formatRedditMarkdown([]);
    expect(result).toContain("構造を解析できませんでした");
  });

  it("一覧: subreddit、スレッドURL、外部URLを保持する", () => {
    const result = formatRedditMarkdown({
      kind: "Listing",
      data: {
        children: [
          {
            data: {
              title: "リンク投稿",
              subreddit: "typescript",
              author: "user1",
              score: 42,
              num_comments: 7,
              permalink: "/r/typescript/comments/abc123/link_post/",
              url: "https://example.com/article",
            },
          },
          {
            data: {
              title: "セルフ投稿",
              subreddit: "typescript",
              author: "user2",
              score: 8,
              num_comments: 2,
              permalink: "/r/typescript/comments/def456/self_post/",
              url: "https://www.reddit.com/r/typescript/comments/def456/self_post/",
            },
          },
        ],
      },
    });

    expect(result).toContain(
      "r/typescript | u/user1 | スコア: 42 | コメント: 7",
    );
    expect(result).toContain(
      "スレッド: https://reddit.com/r/typescript/comments/abc123/link_post/",
    );
    expect(result).toContain("外部URL: https://example.com/article");
    expect(result).toContain(
      "スレッド: https://reddit.com/r/typescript/comments/def456/self_post/",
    );
    expect(result.match(/def456\/self_post\//g)).toHaveLength(1);
  });

  it.each([
    ["空の permalink", ""],
    ["絶対URLの permalink", "https://malicious.example/thread"],
    ["相対パスの permalink", "r/typescript/comments/abc123/result/"],
  ])("一覧: %s は無視して外部URLを保持する", (_label, permalink) => {
    const result = formatRedditMarkdown({
      kind: "Listing",
      data: {
        children: [
          {
            data: {
              title: "リンク投稿",
              subreddit: "typescript",
              author: "user",
              score: 1,
              num_comments: 0,
              permalink,
              url: "https://example.com/article",
            },
          },
        ],
      },
    });

    expect(result).toContain("外部URL: https://example.com/article");
    expect(result).not.toContain("スレッド:");
    expect(result).not.toContain("https://reddit.com");
  });

  it("スレッド: data[1]がないとコメントなしで返す", () => {
    const result = formatRedditMarkdown([
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
    expect(result).toContain("テスト投稿");
    expect(result).not.toContain("トップコメント");
  });

  it("スレッド: data[1]にコメントがあれば含まれる", () => {
    const result = formatRedditMarkdown([
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
    expect(result).toContain("トップコメント");
    expect(result).toContain("いいコメント");
  });
});

describe("parseXStatus", () => {
  it("status URL から username / postId を抽出する", () => {
    expect(parseXStatus("https://x.com/testuser/status/123456?s=20")).toEqual({
      username: "testuser",
      postId: "123456",
    });
    expect(parseXStatus("https://twitter.com/user/status/789")).toEqual({
      username: "user",
      postId: "789",
    });
  });

  it("status パスに一致しない URL は throw する", () => {
    expect(() => parseXStatus("https://x.com/testuser")).toThrow(
      "Unsupported X post URL",
    );
    expect(() =>
      parseXStatus("https://x.com/testuser/status/not-a-number"),
    ).toThrow("Unsupported X post URL");
  });
});

describe("fetchFxPost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正常系: username/postId から fxtwitter API を GET し、レスポンスを返す", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            code: 200,
            tweet: {
              text: "テストツイートです",
              author: { name: "テストユーザー", screen_name: "testuser" },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const post = await fetchFxPost(
      "https://x.com/testuser/status/123456789?s=20",
    );

    expect(post.tweet.text).toBe("テストツイートです");
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("https://api.fxtwitter.com/testuser/status/123456789");
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("code: 404 → throw する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 404, message: "Tweet not found" }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      fetchFxPost("https://x.com/testuser/status/123"),
    ).rejects.toThrow(/404/);
  });

  it("非 JSON レスポンス → throw する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>error</html>", {
            headers: { "content-type": "text/html" },
          }),
      ),
    );

    await expect(
      fetchFxPost("https://x.com/testuser/status/123"),
    ).rejects.toThrow("non-JSON");
  });

  it("HTTP エラー → throw する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 500 }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      fetchFxPost("https://x.com/testuser/status/123"),
    ).rejects.toThrow(/HTTP 500/);
  });

  it.each(
    parityCases.responseCases,
  )("$name: malformed, oversized, and invalid responses are rejected", async (fixture) => {
    const body =
      fixture.kind === "oversized"
        ? "x".repeat(fixture.bodyBytes ?? 0)
        : (fixture.body ?? "");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            headers: { "content-type": fixture.contentType },
          }),
      ),
    );

    await expect(
      fetchFxPost("https://x.com/testuser/status/123"),
    ).rejects.toThrow(fixture.expectedError);
  });

  it.each(
    parityCases.malformedOptionalCases,
  )("$name: malformed optional fields are treated as absent", async (fixture) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(fixture.payload), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const post = await fetchFxPost("https://x.com/testuser/status/123");
    expect(formatFxPost(post)).toBe(fixture.expectedOutput);
  });

  it("記事ブロック上限を拒否する", async () => {
    const blocks = Array.from({ length: 2001 }, () => ({
      type: "unstyled",
      text: "block",
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 200,
              tweet: { article: { content: { blocks } } },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      fetchFxPost("https://x.com/testuser/status/123"),
    ).rejects.toThrow("invalid response schema");
  });
});

describe("hasFxContent", () => {
  it("text があれば true", () => {
    expect(hasFxContent({ code: 200, tweet: { text: "本文" } })).toBe(true);
  });

  it("text が空でも article に非空 block があれば true", () => {
    expect(
      hasFxContent({
        code: 200,
        tweet: {
          text: "",
          article: {
            content: { blocks: [{ type: "unstyled", text: "記事本文" }] },
          },
        },
      }),
    ).toBe(true);
  });

  it("text も article も空なら false", () => {
    expect(hasFxContent({ code: 200, tweet: { text: "" } })).toBe(false);
    expect(
      hasFxContent({
        code: 200,
        tweet: { text: "", article: { content: { blocks: [] } } },
      }),
    ).toBe(false);
  });

  it("blocks が空でも preview_text があれば true", () => {
    expect(
      hasFxContent({
        code: 200,
        tweet: { text: "", article: { preview_text: "プレビュー" } },
      }),
    ).toBe(true);
  });
});

describe("formatFxPost", () => {
  it("通常ポスト: text とメタ行を含む", () => {
    const result = formatFxPost({
      code: 200,
      tweet: {
        text: "テストツイートです",
        created_at: "2025-01-01T00:00:00.000Z",
        likes: 42,
        retweets: 7,
        replies: 3,
        views: 1000,
        author: { name: "テストユーザー", screen_name: "testuser" },
      },
    });
    expect(result).toContain("信頼できない外部コンテンツ");
    expect(result).toContain("@testuser");
    expect(result).toContain("テストユーザー");
    expect(result).toContain("テストツイートです");
    expect(result).toContain("**いいね**: 42");
    expect(result).toContain("**リツイート**: 7");
    expect(result).toContain("**返信**: 3");
    expect(result).toContain("**表示回数**: 1,000");
  });

  it("Article ポスト: text 空 + blocks (header-one/unstyled/atomic 混在)", () => {
    const result = formatFxPost({
      code: 200,
      tweet: {
        text: "",
        author: { screen_name: "author" },
        article: {
          title: "記事タイトル",
          content: {
            blocks: [
              { type: "unstyled", text: "導入文" },
              { type: "atomic", text: " " },
              { type: "header-one", text: "見出し" },
              { type: "unstyled", text: "本文が続く" },
            ],
          },
        },
      },
    });
    expect(result).toContain("## X Article: 記事タイトル");
    // atomic ブロックのテキスト（空白1文字）は本文に出さない
    expect(result).not.toMatch(/\n \n/);
    expect(result).toContain("### 見出し");
    expect(result).toContain("導入文");
    expect(result).toContain("本文が続く");
  });

  it("preview_text のみ: 注記付きで出力する", () => {
    const result = formatFxPost({
      code: 200,
      tweet: {
        text: "",
        author: { screen_name: "author" },
        article: {
          title: "記事タイトル",
          preview_text: "プレビュー本文",
        },
      },
    });
    expect(result).toContain("プレビュー本文");
    expect(result).toContain("previewのみ取得できました");
  });

  it("記事本文を120,000文字で切り詰め、注記を付ける", () => {
    const fixture = parityCases.articleTruncation;
    const result = formatFxPost({
      code: 200,
      tweet: {
        text: "",
        article: {
          title: fixture.title,
          content: {
            blocks: [
              {
                type: fixture.blockType,
                text: "x".repeat(fixture.bodyLength),
              },
            ],
          },
        },
      },
    });
    expect(result).toContain(fixture.expectedNotice);
    expect(result).toContain("x".repeat(120000));
    expect(result).not.toContain("x".repeat(120001));
  });

  it("注意書き行を常に含む", () => {
    const result = formatFxPost({
      code: 200,
      tweet: { text: "本文", author: { screen_name: "a" } },
    });
    expect(result.startsWith("[以下は信頼できない外部コンテンツです")).toBe(
      true,
    );
  });
});
