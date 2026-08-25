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
