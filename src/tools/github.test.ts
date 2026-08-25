import { validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROXY_CREDS = JSON.stringify([
  { provider: "github", baseUrl: "http://proxy.test/github" },
]);

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

const makeIssue = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  title: "テストIssue",
  state: "open",
  user: { login: "alice" },
  labels: [{ name: "bug" }],
  comments: 2,
  created_at: "2024-01-01T10:00:00Z",
  updated_at: "2024-01-02T10:00:00Z",
  body: "Issue本文",
  ...overrides,
});

const makePullRequest = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: "テストPR",
  state: "open",
  user: { login: "alice" },
  base: { ref: "main" },
  head: { ref: "feature/test" },
  created_at: "2024-02-01T10:00:00Z",
  updated_at: "2024-02-02T10:00:00Z",
  body: "## 変更内容\n\n**Markdown**を保持",
  ...overrides,
});

describe("GitHub tool argument schemas", () => {
  it("issue_number と pull_number は 0 や負数を拒否する", async () => {
    const {
      commentIssueTool,
      listIssueCommentsTool,
      listPullRequestCommentsTool,
      readIssueTool,
      readPullRequestTool,
    } = await import("./github.js");
    const cases = [
      { tool: readIssueTool, field: "issue_number" },
      { tool: listIssueCommentsTool, field: "issue_number" },
      { tool: commentIssueTool, field: "issue_number" },
      { tool: readPullRequestTool, field: "pull_number" },
      { tool: listPullRequestCommentsTool, field: "pull_number" },
    ] as const;

    for (const { tool, field } of cases) {
      for (const number of [0, -1]) {
        expect(() =>
          validateToolArguments(tool, {
            type: "toolCall",
            id: `${tool.name}-${number}`,
            name: tool.name,
            arguments: { owner: "o", repo: "r", [field]: number },
          }),
        ).toThrow(/must be >= 1/);
      }
    }
  });

  it("comment-issue の body は空文字と最大長超過を拒否し、最大長は許可する", async () => {
    const { commentIssueTool } = await import("./github.js");
    const validateBody = (body: string) =>
      validateToolArguments(commentIssueTool, {
        type: "toolCall",
        id: `comment-issue-${body.length}`,
        name: "comment-issue",
        arguments: { owner: "o", repo: "r", issue_number: 1, body },
      });

    expect(() => validateBody("")).toThrow(
      "body: must not have fewer than 1 characters",
    );
    expect(() => validateBody("a".repeat(8000))).not.toThrow();
    expect(() => validateBody("a".repeat(8001))).toThrow(
      "body: must not have more than 8000 characters",
    );
  });
});

describe("list-issues", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("Issue 一覧を正しくフォーマットする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { listIssuesTool } = await import("./github.js");
    const result = await listIssuesTool.execute("id", {
      owner: "shin902",
      repo: "my-discord-agent",
    });
    const text = firstText(result);
    expect(text).toContain("#1 テストIssue");
    expect(text).toContain("alice");
    expect(text).toContain("bug");
  });

  it("デフォルトで state=open かつ per_page=10 を叩く", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const { listIssuesTool } = await import("./github.js");
    await listIssuesTool.execute("id", { owner: "o", repo: "r" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/repos/o/r/issues?state=open&per_page=10");
    expect((init.headers as Record<string, string>).Accept).toBe(
      "application/vnd.github+json",
    );
  });

  it("limit=100 を上限 50 にクランプする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const { listIssuesTool } = await import("./github.js");
    await listIssuesTool.execute("id", { owner: "o", repo: "r", limit: 100 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("per_page=50");
  });

  it("pull_request を含む結果は除外する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        makeIssue(),
        makeIssue({ number: 2, pull_request: {} }),
      ],
    });
    const { listIssuesTool } = await import("./github.js");
    const result = await listIssuesTool.execute("id", {
      owner: "o",
      repo: "r",
    });
    const text = firstText(result);
    expect(text).toContain("#1");
    expect(text).not.toContain("#2");
  });

  it("先頭ページが PR 中心でも次ページから Issue を limit 件まで取得する", async () => {
    const firstPage = [
      makeIssue({ number: 101, pull_request: {} }),
      makeIssue({ number: 102, pull_request: {} }),
    ];
    const secondPage = [makeIssue({ number: 1 }), makeIssue({ number: 2 })];
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("&page=2") ? secondPage : firstPage),
    }));

    const { listIssuesTool } = await import("./github.js");
    const result = await listIssuesTool.execute("id", {
      owner: "o",
      repo: "r",
      limit: 2,
    });
    const text = firstText(result);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://proxy.test/github/repos/o/r/issues?state=open&per_page=2&page=1",
      "http://proxy.test/github/repos/o/r/issues?state=open&per_page=2&page=2",
    ]);
    expect(text).toContain("#1");
    expect(text).toContain("#2");
    expect(text).not.toContain("#101");
    expect(text).not.toContain("#102");
    expect(result.details).toMatchObject({ count: 2 });
  });

  it("結果が空のとき「Issue はありません」を返す", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const { listIssuesTool } = await import("./github.js");
    const result = await listIssuesTool.execute("id", {
      owner: "o",
      repo: "r",
    });
    expect(firstText(result)).toContain("Issue はありません");
  });

  it("owner/repo に不正な文字が含まれると例外", async () => {
    const { listIssuesTool } = await import("./github.js");
    await expect(
      listIssuesTool.execute("id", { owner: "o/../x", repo: "r" }),
    ).rejects.toThrow("無効なowner");
  });

  it("owner が .. のときパストラバーサルとして例外", async () => {
    const { listIssuesTool } = await import("./github.js");
    await expect(
      listIssuesTool.execute("id", { owner: "..", repo: "r" }),
    ).rejects.toThrow("無効なowner");
  });

  it("GitHub API エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
    const { listIssuesTool } = await import("./github.js");
    await expect(
      listIssuesTool.execute("id", { owner: "o", repo: "r" }),
    ).rejects.toThrow("404");
  });

  it("github プロバイダーが CREDENTIAL_PROXY_JSON にない場合は例外", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "openai", baseUrl: "http://proxy.test/openai" },
    ]);
    const { listIssuesTool } = await import("./github.js");
    await expect(
      listIssuesTool.execute("id", { owner: "o", repo: "r" }),
    ).rejects.toThrow(
      "github プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません",
    );
  });
});

describe("read-issue", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("指定した issue_number で GitHub API を叩く", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeIssue() });
    const { readIssueTool } = await import("./github.js");
    await readIssueTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
    });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/repos/o/r/issues/1");
  });

  it("Issue のタイトル・本文・メタ情報をフォーマットする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeIssue() });
    const { readIssueTool } = await import("./github.js");
    const result = await readIssueTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
    });
    const text = firstText(result);
    expect(text).toContain("#1 テストIssue");
    expect(text).toContain("alice");
    expect(text).toContain("Issue本文");
  });

  it("本文が 8000 文字を超えたら省略する", async () => {
    const longBody = "a".repeat(10000);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeIssue({ body: longBody }),
    });
    const { readIssueTool } = await import("./github.js");
    const result = await readIssueTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
    });
    const text = firstText(result);
    expect(text).toContain("2000 文字省略");
  });

  it("owner/repo に不正な文字が含まれると例外", async () => {
    const { readIssueTool } = await import("./github.js");
    await expect(
      readIssueTool.execute("id", {
        owner: "o",
        repo: "../r",
        issue_number: 1,
      }),
    ).rejects.toThrow("無効なrepo");
  });
});

describe("read-pull-request", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("pull_number で Pull Request の endpoint を選択する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makePullRequest(),
    });
    const { readPullRequestTool } = await import("./github.js");
    await readPullRequestTool.execute("id", {
      owner: "o",
      repo: "r",
      pull_number: 42,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://proxy.test/github/repos/o/r/pulls/42",
    );
  });

  it("PR のメタ情報と base/head、本文 Markdown をフォーマットする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makePullRequest(),
    });
    const { readPullRequestTool } = await import("./github.js");
    const result = await readPullRequestTool.execute("id", {
      owner: "o",
      repo: "r",
      pull_number: 42,
    });
    const text = firstText(result);

    expect(text).toContain("# #42 テストPR");
    expect(text).toContain("**状態**: open");
    expect(text).toContain("**作成者**: alice");
    expect(text).toContain("**ベースブランチ**: main");
    expect(text).toContain("**ヘッドブランチ**: feature/test");
    expect(text).toContain("**作成日時**: 2024-02-01T10:00:00Z");
    expect(text).toContain("**更新日時**: 2024-02-02T10:00:00Z");
    expect(text).toContain("## 変更内容");
    expect(text).toContain("**Markdown**を保持");
    expect(result.details).toEqual({ owner: "o", repo: "r", pull_number: 42 });
  });

  it("optional fields が欠落または空でも不明/本文なしとして出力する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makePullRequest({
          state: "",
          user: { login: "" },
          base: { ref: "" },
          head: {},
          created_at: "",
          updated_at: undefined,
          body: null,
        }),
    });
    const { readPullRequestTool } = await import("./github.js");
    const result = await readPullRequestTool.execute("id", {
      owner: "o",
      repo: "r",
      pull_number: 42,
    });
    const text = firstText(result);

    expect(text).toContain("**状態**: 不明");
    expect(text).toContain("**作成者**: 不明");
    expect(text).toContain("**ベースブランチ**: 不明");
    expect(text).toContain("**ヘッドブランチ**: 不明");
    expect(text).toContain("**作成日時**: 不明");
    expect(text).toContain("**更新日時**: 不明");
    expect(text).toContain("(本文なし)");
    expect(text).not.toContain("undefined");
  });

  it("本文が 8000 文字を超えたら省略する", async () => {
    const longBody = "a".repeat(10000);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makePullRequest({ body: longBody }),
    });
    const { readPullRequestTool } = await import("./github.js");
    const result = await readPullRequestTool.execute("id", {
      owner: "o",
      repo: "r",
      pull_number: 42,
    });

    expect(firstText(result)).toContain("2000 文字省略");
  });

  it("GitHub API エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    });
    const { readPullRequestTool } = await import("./github.js");

    await expect(
      readPullRequestTool.execute("id", {
        owner: "o",
        repo: "r",
        pull_number: 42,
      }),
    ).rejects.toThrow("404");
  });
});

describe("list-issue-comments", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  const makeComment = (overrides: Record<string, unknown> = {}) => ({
    id: 101,
    user: { login: "bob" },
    created_at: "2024-02-01T10:00:00Z",
    updated_at: "2024-02-02T10:00:00Z",
    body: "**Markdown**\n\n- item",
    ...overrides,
  });

  it("コメントの作者・日時・本文を Markdown でフォーマットする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeComment()],
    });
    const { listIssueCommentsTool } = await import("./github.js");
    const result = await listIssueCommentsTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
    });
    const text = firstText(result);

    expect(text).toContain("# Issue #1 のコメント");
    expect(text).toContain("## コメント 1");
    expect(text).toContain("作者: bob");
    expect(text).toContain("投稿日時: 2024-02-01T10:00:00Z");
    expect(text).toContain("更新日時: 2024-02-02T10:00:00Z");
    expect(text).toContain("**Markdown**");
    expect(text).toContain("- item");
    expect(result.details).toEqual({
      owner: "o",
      repo: "r",
      issue_number: 1,
      count: 1,
    });
  });

  it("per_page 件で満たされたページの次ページまで全件取得する", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      makeComment({ id: index + 1, body: `comment ${index + 1}` }),
    );
    const secondPage = [makeComment({ id: 101, body: "comment 101" })];
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("page=2") ? secondPage : firstPage),
    }));

    const { listIssueCommentsTool } = await import("./github.js");
    const result = await listIssueCommentsTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://proxy.test/github/repos/o/r/issues/1/comments?per_page=100&page=1",
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      "http://proxy.test/github/repos/o/r/issues/1/comments?per_page=100&page=2",
    );
    expect(firstText(result)).toContain("comment 101");
    expect(result.details).toMatchObject({ count: 101 });
  });

  it("コメントがないときはその旨を返す", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const { listIssueCommentsTool } = await import("./github.js");
    const result = await listIssueCommentsTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
    });

    expect(firstText(result)).toContain("コメントはありません");
  });

  it("GitHub API エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    const { listIssueCommentsTool } = await import("./github.js");

    await expect(
      listIssueCommentsTool.execute("id", {
        owner: "o",
        repo: "r",
        issue_number: 1,
      }),
    ).rejects.toThrow("500");
  });
});

describe("list-pull-request-comments", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  const makeConversationComment = (
    overrides: Record<string, unknown> = {},
  ) => ({
    id: 101,
    user: { login: "bob" },
    created_at: "2024-03-01T10:00:00Z",
    updated_at: "2024-03-02T10:00:00Z",
    body: "**conversation**",
    ...overrides,
  });

  const makeReview = (overrides: Record<string, unknown> = {}) => ({
    id: 201,
    user: { login: "carol" },
    state: "APPROVED",
    submitted_at: "2024-03-03T10:00:00Z",
    updated_at: "2024-03-04T10:00:00Z",
    body: "review *body*",
    ...overrides,
  });

  const makeInlineComment = (overrides: Record<string, unknown> = {}) => ({
    id: 301,
    user: { login: "dave" },
    created_at: "2024-03-05T10:00:00Z",
    updated_at: "2024-03-06T10:00:00Z",
    body: "`inline` comment",
    path: "src/example.ts",
    line: 12,
    original_line: 10,
    side: "RIGHT",
    ...overrides,
  });

  const executeTool = async () => {
    const { listPullRequestCommentsTool } = await import("./github.js");
    return listPullRequestCommentsTool.execute("id", {
      owner: "o",
      repo: "r",
      pull_number: 42,
    });
  };

  it("三つの API の結果を種類ごとに Markdown でフォーマットする", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/issues/42/comments")) {
        return { ok: true, json: async () => [makeConversationComment()] };
      }
      if (url.includes("/pulls/42/reviews")) {
        return { ok: true, json: async () => [makeReview()] };
      }
      if (url.includes("/pulls/42/comments")) {
        return { ok: true, json: async () => [makeInlineComment()] };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await executeTool();
    const text = firstText(result);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "http://proxy.test/github/repos/o/r/issues/42/comments?per_page=100&page=1",
      "http://proxy.test/github/repos/o/r/pulls/42/reviews?per_page=100&page=1",
      "http://proxy.test/github/repos/o/r/pulls/42/comments?per_page=100&page=1",
    ]);
    expect(text).toContain("# Pull Request #42 のコメント・レビュー");
    expect(text).toContain("## 会話コメント（Issue コメント）");
    expect(text).toContain("作者: bob");
    expect(text).toContain("2024-03-01T10:00:00Z");
    expect(text).toContain("**conversation**");
    expect(text).toContain("## レビュー投稿");
    expect(text).toContain("作者: carol");
    expect(text).toContain("状態: APPROVED");
    expect(text).toContain("提出日時: 2024-03-03T10:00:00Z");
    expect(text).toContain("review *body*");
    expect(text).toContain("## インラインレビューコメント");
    expect(text).toContain("作者: dave");
    expect(text).toContain("path=src/example.ts");
    expect(text).toContain("line=12");
    expect(text).toContain("original_line=10");
    expect(text).toContain("side=RIGHT");
    expect(text).toContain("`inline` comment");
    expect(text).not.toContain("undefined");
    expect(result.details).toMatchObject({
      owner: "o",
      repo: "r",
      pull_number: 42,
      count: 3,
    });
  });

  it("三つの API で 100 件を超える全ページを取得する", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      const requestUrl = new URL(url);
      const page = requestUrl.searchParams.get("page");
      const firstPage = page === "1";
      if (requestUrl.pathname.endsWith("/issues/42/comments")) {
        return {
          ok: true,
          json: async () =>
            firstPage
              ? Array.from({ length: 100 }, (_, index) =>
                  makeConversationComment({
                    id: index,
                    body: `conversation-${index}`,
                  }),
                )
              : [
                  makeConversationComment({
                    id: 101,
                    body: "conversation-page-2",
                  }),
                ],
        };
      }
      if (requestUrl.pathname.endsWith("/pulls/42/reviews")) {
        return {
          ok: true,
          json: async () =>
            firstPage
              ? Array.from({ length: 100 }, (_, index) =>
                  makeReview({ id: index, body: `review-${index}` }),
                )
              : [makeReview({ id: 101, body: "review-page-2" })],
        };
      }
      if (requestUrl.pathname.endsWith("/pulls/42/comments")) {
        return {
          ok: true,
          json: async () =>
            firstPage
              ? Array.from({ length: 100 }, (_, index) =>
                  makeInlineComment({ id: index, body: `inline-${index}` }),
                )
              : [makeInlineComment({ id: 101, body: "inline-page-2" })],
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const result = await executeTool();
    const urls = fetchMock.mock.calls.map(([url]) => url as string);

    expect(urls).toHaveLength(6);
    expect(urls).toEqual([
      "http://proxy.test/github/repos/o/r/issues/42/comments?per_page=100&page=1",
      "http://proxy.test/github/repos/o/r/issues/42/comments?per_page=100&page=2",
      "http://proxy.test/github/repos/o/r/pulls/42/reviews?per_page=100&page=1",
      "http://proxy.test/github/repos/o/r/pulls/42/reviews?per_page=100&page=2",
      "http://proxy.test/github/repos/o/r/pulls/42/comments?per_page=100&page=1",
      "http://proxy.test/github/repos/o/r/pulls/42/comments?per_page=100&page=2",
    ]);
    const text = firstText(result);
    expect(text).toContain("conversation-page-2");
    expect(text).toContain("review-page-2");
    expect(text).toContain("inline-page-2");
  });

  it("空のカテゴリを明示し、null や欠落フィールドを安全に扱う", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/issues/42/comments")) {
        return {
          ok: true,
          json: async () => [
            makeConversationComment({
              user: null,
              created_at: null,
              updated_at: undefined,
              body: null,
            }),
          ],
        };
      }
      if (url.includes("/pulls/42/reviews")) {
        return {
          ok: true,
          json: async () => [
            makeReview({
              user: null,
              state: null,
              created_at: null,
              submitted_at: null,
              updated_at: undefined,
              body: null,
            }),
          ],
        };
      }
      return {
        ok: true,
        json: async () => [
          makeInlineComment({
            user: null,
            created_at: null,
            updated_at: undefined,
            body: null,
            path: null,
            line: null,
            original_line: undefined,
            side: null,
          }),
        ],
      };
    });

    const result = await executeTool();
    const text = firstText(result);

    expect(text).toContain("作者: 不明");
    expect(text).toContain("提出日時: 不明");
    expect(text).toContain("(本文なし)");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("位置:");

    fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
    const emptyResult = await executeTool();
    const emptyText = firstText(emptyResult);
    expect(emptyText).toContain("(会話コメントはありません)");
    expect(emptyText).toContain("(レビューはありません)");
    expect(emptyText).toContain("(インラインレビューコメントはありません)");
  });

  it("いずれかの GitHub API が失敗したら例外を返す", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => "Bad Gateway",
    });

    await expect(executeTool()).rejects.toThrow("502");
  });
});

describe("comment-issue", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("指定した issue_number にコメントを POST する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, html_url: "http://example.test/comment/1" }),
    });
    const { commentIssueTool } = await import("./github.js");
    const result = await commentIssueTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
      body: "コメント本文",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/repos/o/r/issues/1/comments");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ body: "コメント本文" });
    expect(firstText(result)).toContain("http://example.test/comment/1");
  });

  it("本文が空文字だと例外を投げ、API を呼ばない", async () => {
    const { commentIssueTool } = await import("./github.js");
    await expect(
      commentIssueTool.execute("id", {
        owner: "o",
        repo: "r",
        issue_number: 1,
        body: "",
      }),
    ).rejects.toThrow("コメント本文は空にできません");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("本文が最大文字数ちょうどならコメントを POST する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: 1, html_url: "http://example.test/comment/1" }),
    });
    const { commentIssueTool } = await import("./github.js");
    const body = "a".repeat(8000);
    await commentIssueTool.execute("id", {
      owner: "o",
      repo: "r",
      issue_number: 1,
      body,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ body });
  });

  it("本文が最大文字数を超えると例外を投げ、API を呼ばない", async () => {
    const { commentIssueTool } = await import("./github.js");
    await expect(
      commentIssueTool.execute("id", {
        owner: "o",
        repo: "r",
        issue_number: 1,
        body: "a".repeat(8001),
      }),
    ).rejects.toThrow("コメント本文が長すぎます");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("owner/repo に不正な文字が含まれると例外", async () => {
    const { commentIssueTool } = await import("./github.js");
    await expect(
      commentIssueTool.execute("id", {
        owner: "o",
        repo: "../r",
        issue_number: 1,
        body: "本文",
      }),
    ).rejects.toThrow("無効なrepo");
  });

  it("GitHub API エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });
    const { commentIssueTool } = await import("./github.js");
    await expect(
      commentIssueTool.execute("id", {
        owner: "o",
        repo: "r",
        issue_number: 1,
        body: "本文",
      }),
    ).rejects.toThrow("403");
  });
});
