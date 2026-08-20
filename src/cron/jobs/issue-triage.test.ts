import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubIssue } from "../../tools/github.js";
import type { CronContext } from "../runner.js";

// SAFETY: the test fixture is constructed with the domain shape required by this boundary.
let store = { content: null as string | null };

const makeIssue = (overrides: Partial<{
  number: number;
  title: string;
  user: { login: string };
  state: string;
  updated_at: string;
  comments: number;
  pull_request: Record<string, string>;
}> = {}) => ({
  number: 1,
  title: "テストIssue",
  state: "open",
  user: { login: "shin902" },
  updated_at: "2024-01-02T10:00:00Z",
  ...overrides,
});

function makeCtx(overrides: Partial<CronContext> = {}): CronContext {
  // SAFETY: the fixture contains the CronContext fields exercised by these tests.
  return {
    id: "issue-triage",
    schedule: "0 * * * *",
    enabled: true,
    channelId: "channel-1",
    groupName: "issue-triage",
    appendInbox: vi.fn(async () => undefined),
    // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
    client: {} as CronContext["client"],
    settings: { owner: "shin902", repo: "my-discord-agent" },
    ...overrides,
  // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
  } as CronContext;
}

describe("issue-triage handler", () => {
  let fetchMock: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<{
    ok: boolean;
    status?: number;
    json?(): Promise<GitHubIssue[]>;
    text?(): Promise<string>;
  }>>>;

  beforeEach(() => {
    vi.resetModules();
    store = { content: null };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("channelId が無ければ NonRetryableError を投げる", async () => {
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    await expect(handler(makeCtx({ channelId: undefined }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("groupName が無ければ NonRetryableError を投げる", async () => {
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    await expect(handler(makeCtx({ groupName: undefined }))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settings が不正なら NonRetryableError を投げる", async () => {
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    await expect(
      handler(makeCtx({ settings: { owner: "shin902" } })),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("オーナー以外の投稿者によるIssueは処理対象から除外する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ user: { login: "mallory" } })],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("allowedAuthors に含まれる投稿者のIssueは処理対象にする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ user: { login: "bob" } })],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx({
      settings: {
        owner: "shin902",
        repo: "my-discord-agent",
        allowedAuthors: ["bob"],
      },
    });
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
  });

  it("オーナーのIssueに対し appendInbox でプロンプトを投入する", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
    // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
    const arg = (ctx.appendInbox as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.channelId).toBe("channel-1");
    expect(arg.groupName).toBe("issue-triage");
    expect(arg.content).toContain("#1");
    expect(arg.content).toContain("テストIssue");
  });

  it("pull_request を含む結果は除外する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ pull_request: {} })],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("updated_at が変化していないIssueは再処理しない", async () => {
    store.content = JSON.stringify({
      "shin902/my-discord-agent#1": {
        updatedAt: "2024-01-02T10:00:00Z",
        commentCount: 0,
      },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("updated_at が変化していれば再処理する", async () => {
    store.content = JSON.stringify({
      "shin902/my-discord-agent#1": {
        updatedAt: "2024-01-01T00:00:00Z",
        commentCount: 0,
      },
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
  });

  it("updated_at は変化したがコメント数が前回投入分の+1だけなら、bot自身のコメントとみなし再処理しない", async () => {
    store.content = JSON.stringify({
      "shin902/my-discord-agent#1": {
        updatedAt: "2024-01-01T00:00:00Z",
        commentCount: 0,
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ comments: 1 })],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
    // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
    const saved = JSON.parse(store.content as string);
    expect(saved["shin902/my-discord-agent#1"]).toEqual({
      updatedAt: "2024-01-02T10:00:00Z",
      commentCount: 1,
    });
  });

  it("コメント数が+2以上増えていれば再処理する（owner自身の追加コメントとみなす）", async () => {
    store.content = JSON.stringify({
      "shin902/my-discord-agent#1": {
        updatedAt: "2024-01-01T00:00:00Z",
        commentCount: 0,
      },
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ comments: 2 })],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
  });

  it("処理後に state.json を保存する", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(store.content).not.toBeNull();
    // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
    const saved = JSON.parse(store.content as string);
    expect(saved["shin902/my-discord-agent#1"]).toEqual({
      updatedAt: "2024-01-02T10:00:00Z",
      commentCount: 0,
    });
  });

  it("GitHub API エラー時はエラーを投げてappendInboxを呼ばない（次tickでリトライさせる）", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Server Error",
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await expect(handler(ctx)).rejects.toThrow();
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("ページネーション: per_page 件で打ち切られた場合は次ページも取得する", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      makeIssue({ number: i + 1, updated_at: "2024-01-02T10:00:00Z" }),
    );
    const page2 = [
      makeIssue({ number: 101, updated_at: "2024-01-02T10:00:00Z" }),
    ];
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("page=2")) {
        return { ok: true, json: async () => page2 };
      }
      return { ok: true, json: async () => page1 };
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(101);
    // page1(100件、満杯のため継続) -> page2(1件、PER_PAGE未満のため終了)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("不正な owner/repo は NonRetryableError を投げ appendInbox を呼ばない", async () => {
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx({
      settings: { owner: "..", repo: "my-discord-agent" },
    });
    await expect(handler(ctx)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("大文字小文字が違うユーザー名でも owner として許可される", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ user: { login: "SHIN902" } })],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx({
      settings: { owner: "Shin902", repo: "my-discord-agent" },
    });
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
  });

  it("大文字小文字が違う allowedAuthors でも許可される", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ user: { login: "Bob" } })],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx({
      settings: {
        owner: "shin902",
        repo: "my-discord-agent",
        allowedAuthors: ["bob"],
      },
    });
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
  });

  it("appendInbox 成功ごとに state.json が保存される（途中失敗時も先行分は残る）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        makeIssue({ number: 1, updated_at: "2024-01-02T10:00:00Z" }),
        makeIssue({ number: 2, updated_at: "2024-01-02T11:00:00Z" }),
      ],
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const appendInbox = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fail"));
    const ctx = makeCtx({ appendInbox });
    await handler(ctx);
    expect(appendInbox).toHaveBeenCalledTimes(2);
    // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
    const saved = JSON.parse(store.content as string);
    // Issue #1 の appendInbox は成功しているため、#2 が失敗してもstateに残る
    expect(saved["shin902/my-discord-agent#1"]).toEqual({
      updatedAt: "2024-01-02T10:00:00Z",
      commentCount: 0,
    });
    expect(saved["shin902/my-discord-agent#2"]).toBeUndefined();
  });

  it("2つのジョブが同一tickで並行実行されても、互いの state 更新を上書きしない", async () => {
    // owner/repo が異なる2つのジョブ（例: 別リポジトリを棚卸しする2つ目のcronジョブ）を
    // ほぼ同時に実行し、片方の書き込みがもう片方を消さないことを確認する
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/repos/shin902/repo-a/")) {
        return {
          ok: true,
          json: async () => [
            makeIssue({ number: 1, updated_at: "2024-01-02T10:00:00Z" }),
          ],
        };
      }
      return {
        ok: true,
        json: async () => [
          makeIssue({ number: 1, updated_at: "2024-01-02T11:00:00Z" }),
        ],
      };
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctxA = makeCtx({
      settings: { owner: "shin902", repo: "repo-a" },
      appendInbox: vi.fn(async () => undefined),
    });
    const ctxB = makeCtx({
      settings: { owner: "shin902", repo: "repo-b" },
      appendInbox: vi.fn(async () => undefined),
    });
    await Promise.all([handler(ctxA), handler(ctxB)]);
    // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
    const saved = JSON.parse(store.content as string);
    expect(saved["shin902/repo-a#1"]).toEqual({
      updatedAt: "2024-01-02T10:00:00Z",
      commentCount: 0,
    });
    expect(saved["shin902/repo-b#1"]).toEqual({
      updatedAt: "2024-01-02T11:00:00Z",
      commentCount: 0,
    });
  });

  it("GitHub API呼び出しに creator フィルタを付与する（投稿者以外の取得・ページングを避ける）", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    // SAFETY: the test fixture is constructed with the domain shape required by this boundary.
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("creator=shin902");
  });

  it("allowedAuthors が複数の場合は author ごとに creator フィルタ付きで取得し、重複Issueは1件にまとめる", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("creator=alice")) {
        return {
          ok: true,
          json: async () => [
            makeIssue({ number: 1, user: { login: "alice" } }),
          ],
        };
      }
      if (url.includes("creator=bob")) {
        // bob にも #1 を重複して返すケース（実APIでは起きないが、防御的de-dupを確認する）
        return {
          ok: true,
          json: async () => [
            makeIssue({ number: 1, user: { login: "alice" } }),
            makeIssue({ number: 2, user: { login: "bob" } }),
          ],
        };
      }
      return { ok: true, json: async () => [] };
    });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx({
      settings: {
        owner: "shin902",
        repo: "my-discord-agent",
        allowedAuthors: ["alice", "bob"],
      },
    });
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(2);
  });

  it("Open Issue が MAX_PAGES の上限に達した場合は警告ログを出す", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fullPage = Array.from({ length: 100 }, (_, i) =>
      makeIssue({ number: i + 1 }),
    );
    fetchMock.mockResolvedValue({ ok: true, json: async () => fullPage });
    const { createIssueTriageHandler } = await import("./issue-triage.js");
    const handler = createIssueTriageHandler({
      exists: () => store.content !== null,
      mkdir: async () => undefined,
      readFile: async () => store.content ?? "",
      writeFile: async (_path, data) => { store.content = data; },
      getProxyPort: () => 12345,
      fetch: fetchMock,
    });
    const ctx = makeCtx();
    await handler(ctx);
    expect(warnSpy).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(10);
    warnSpy.mockRestore();
  });
});
