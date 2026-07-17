import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCommand,
  buildGitHubMarkdown,
  buildRedditMarkdown,
  detectService,
  fetchFxPost,
  fetchXArticle,
  fetchXPost,
  formatFxPost,
  formatHttpError,
  formatXArticle,
  formatXPost,
  getHttpErrorBodyPath,
  hasFxContent,
  normalizeUrl,
  parseHttpStatus,
  parseVtt,
  parseXArticleId,
  parseXPostId,
  parseXStatus,
  readLimitedJson,
  toSafeReaderError,
} from "./agent-reach.js";

describe("normalizeUrl", () => {
  it("YouTube 以外では query と fragment を除去する", () => {
    expect(
      normalizeUrl(
        "https://example.com/article?utm_source=discord&ref=test#section",
      ),
    ).toBe("https://example.com/article");
  });

  it("YouTube では query を保持し fragment だけ除去する", () => {
    expect(
      normalizeUrl("https://www.youtube.com/watch?v=abc&utm_source=x#chapter"),
    ).toBe("https://www.youtube.com/watch?v=abc&utm_source=x");
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

describe("X Article helpers", () => {
  afterEach(() => {
    delete process.env.CREDENTIAL_PROXY_JSON;
    vi.unstubAllGlobals();
  });

  it("parseXArticleId は対応URLから ID を抽出し query/fragment を無視する", () => {
    expect(
      parseXArticleId("https://x.com/i/article/123456?utm=x#fragment"),
    ).toBe("123456");
    expect(parseXArticleId("https://twitter.com/user/article/789")).toBe("789");
  });

  it.each([
    ["http://x.com/i/article/123", "HTTPS"],
    ["https://example.com/i/article/123", "Only X/Twitter"],
    ["https://user:pass@x.com/i/article/123", "credentials"],
    ["https://x.com:443/i/article/123", "credentials"],
    ["https://x.com/i/article/not-number", "Unsupported"],
    [`https://x.com/i/article/123?${"a".repeat(2050)}`, "too long"],
  ])("不正な Article URL を拒否する: %s", (url, message) => {
    expect(() => parseXArticleId(url)).toThrow(message);
  });

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

  it("toSafeReaderError は reader の生メッセージを含めずコードだけを安全に返す", () => {
    const err = toSafeReaderError(502, {
      error: {
        code: "AUTH_EXPIRED",
        message: "raw secret cookie auth_token=SECRET",
        retryable: false,
      },
    });
    expect(err.message).toContain("AUTH_EXPIRED");
    expect(err.message).not.toContain("SECRET");
    expect(err.message).not.toContain("raw secret");
  });

  it("fetchXArticle は Credential Proxy の x-article base URL に Article ID だけを送る", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "x-article", baseUrl: "http://localhost:8788/x-article" },
    ]);
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            articleId: "123",
            postId: "456",
            canonicalUrl: "https://x.com/i/article/123",
            title: "記事タイトル",
            author: { username: "example" },
            previewText: "preview",
            plainText: "本文",
            media: [],
            publishedAt: "2026-07-01T00:00:00Z",
            source: "x-internal-graphql",
            contentTruncated: false,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const article = await fetchXArticle(
      "https://x.com/i/article/123?utm=secret#frag",
    );

    expect(article.articleId).toBe("123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("http://localhost:8788/x-article/v1/article");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      articleId: "123",
      format: "plain",
    });
    expect(String(init.body)).not.toContain("utm");
    expect(String(init.body)).not.toContain("https://x.com");
  });

  it("fetchXArticle は reader エラーを安全な tool error に変換する", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "x-article", baseUrl: "http://localhost:8788/x-article" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "RATE_LIMITED",
                message: "upstream body with cookie=SECRET",
                retryable: true,
              },
            }),
            { status: 429, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(fetchXArticle("https://x.com/i/article/123")).rejects.toThrow(
      /RATE_LIMITED/,
    );
    await expect(
      fetchXArticle("https://x.com/i/article/123"),
    ).rejects.not.toThrow(/SECRET/);
  });

  it("fetchXArticle は schema 不正 response を拒否する", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "x-article", baseUrl: "http://localhost:8788/x-article" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ articleId: "not-number" }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      fetchXArticle("https://x.com/i/article/123"),
    ).rejects.toThrow();
  });

  it("parseXPostId は status URL から ID を抽出する", () => {
    expect(parseXPostId("https://x.com/user/status/123456?s=20")).toBe(
      "123456",
    );
    expect(parseXPostId("https://twitter.com/user/status/789")).toBe("789");
  });

  it("fetchXPost は Credential Proxy の x-article base URL に post ID だけを送る", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "x-article", baseUrl: "http://localhost:8788/x-article" },
    ]);
    const fetchMock = vi.fn(
      async (_input: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            postId: "123",
            canonicalUrl: "https://x.com/example/status/123",
            author: { username: "example" },
            text: "投稿本文",
            media: [],
            publishedAt: "2026-07-01T00:00:00Z",
            source: "x-internal-graphql",
            contentTruncated: false,
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const post = await fetchXPost("https://x.com/example/status/123?s=20");

    expect(post.text).toBe("投稿本文");
    const [input, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(input).toBe("http://localhost:8788/x-article/v1/post");
    expect(JSON.parse(String(init.body))).toEqual({ postId: "123" });
    expect(String(init.body)).not.toContain("s=20");
    expect(String(init.body)).not.toContain("https://x.com");
  });

  it("formatXPost は本文と外部コンテンツ警告を含む", () => {
    const text = formatXPost({
      postId: "123",
      canonicalUrl: "https://x.com/example/status/123",
      author: { username: "example" },
      text: "投稿本文",
      media: [],
      source: "x-internal-graphql",
      contentTruncated: false,
    });
    expect(text).toContain("信頼できない外部コンテンツ");
    expect(text).toContain("@example");
    expect(text).toContain("投稿本文");
  });

  it("formatXArticle は切り詰め注意と外部コンテンツ警告を含む", () => {
    const text = formatXArticle({
      articleId: "123",
      canonicalUrl: "https://x.com/i/article/123",
      title: "タイトル",
      author: { name: "Example" },
      plainText: "本文",
      media: [],
      source: "x-internal-graphql",
      contentTruncated: true,
    });
    expect(text).toContain("信頼できない外部コンテンツ");
    expect(text).toContain("# タイトル");
    expect(text).toContain("切り詰め");
    expect(text).toContain("本文");
  });
});

describe("buildCommand シェルエスケープ", () => {
  const out = "/workspace/fetched/out.md";

  describe("reddit", () => {
    beforeEach(() => {
      process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
        { provider: "reddit", baseUrl: "http://localhost:12345/reddit" },
      ]);
    });

    afterEach(() => {
      delete process.env.CREDENTIAL_PROXY_JSON;
    });

    it("通常URL → .json を付与し credential-proxy 経由のcurlを生成", () => {
      const cmd = buildCommand(
        "reddit",
        "https://www.reddit.com/r/programming/comments/abc/",
        out,
      );
      expect(cmd).toContain(
        "http://localhost:12345/reddit/r/programming/comments/abc.json",
      );
      expect(cmd).toContain("curl -sS");
      expect(cmd).toContain("-w '%{http_code}'");
    });

    it("ルートURL → /.json を付与し credential-proxy のパスを維持", () => {
      const cmd = buildCommand("reddit", "https://reddit.com/", out);
      expect(cmd).toContain("http://localhost:12345/reddit/.json");
      expect(cmd).not.toContain("http://localhost:12345/reddit.json");
    });

    it("既に .json で終わるURLは二重に付与しない", () => {
      const cmd = buildCommand(
        "reddit",
        "https://www.reddit.com/r/programming/comments/abc.json",
        out,
      );
      expect(cmd).toContain(
        "http://localhost:12345/reddit/r/programming/comments/abc.json",
      );
      expect(cmd).not.toContain(".json.json");
    });

    it("クエリ文字列を維持する", () => {
      const cmd = buildCommand(
        "reddit",
        "https://www.reddit.com/r/programming/comments/abc/?sort=top",
        out,
      );
      expect(cmd).toContain(
        "http://localhost:12345/reddit/r/programming/comments/abc.json?sort=top",
      );
    });

    it("シングルクォートを含むURLをエスケープする", () => {
      const url = "https://www.reddit.com/r/test/it's-test";
      const cmd = buildCommand("reddit", url, out);
      expect(cmd).toContain("'\\''");
    });

    it("CREDENTIAL_PROXY_JSON が未設定の場合は例外を投げる", () => {
      delete process.env.CREDENTIAL_PROXY_JSON;
      expect(() =>
        buildCommand(
          "reddit",
          "https://www.reddit.com/r/programming/comments/abc/",
          out,
        ),
      ).toThrow("CREDENTIAL_PROXY_JSON が設定されていません");
    });
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

  it("github-repo: パスが /owner/repo 未満なら throw", () => {
    expect(() =>
      buildCommand("github-repo", "https://github.com/owner", out),
    ).toThrow("GitHub URL からリポジトリを取得できません");
  });

  it("web: jina.ai 経由でcurl", () => {
    const cmd = buildCommand("web", "https://example.com/article", out);
    expect(cmd).toContain("r.jina.ai");
    expect(cmd).toContain("curl -sS");
    expect(cmd).toContain("-w '%{http_code}'");
  });

  it("x-twitter: native fetch handler (fetchFxPost/fetchXPost) に委譲するため throw する", () => {
    expect(() =>
      buildCommand("x-twitter", "https://x.com/testuser/status/123456789", out),
    ).toThrow("native fetch handler");
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

  it.each([
    "web",
    "x-twitter",
    "reddit",
  ] as const)("%s は absPath をそのまま返す", (service) => {
    expect(getHttpErrorBodyPath(service, absPath)).toBe(absPath);
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

describe("x-twitter フォールバック", () => {
  it("fetchFxPost が throw しても fetchXPost は独立して動作する（reader 経路は生きている）", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "x-article", baseUrl: "http://localhost:8788/x-article" },
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              postId: "123",
              canonicalUrl: "https://x.com/example/status/123",
              author: { username: "example" },
              text: "reader経由の本文",
              media: [],
              source: "x-internal-graphql",
              contentTruncated: false,
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const post = await fetchXPost("https://x.com/example/status/123");
    expect(post.text).toBe("reader経由の本文");

    delete process.env.CREDENTIAL_PROXY_JSON;
    vi.unstubAllGlobals();
  });
});
