import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronContext } from "../runner.js";

let store: { content: string | null } = { content: null };

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => store.content !== null),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => store.content ?? ""),
  writeFile: vi.fn(async (_path: string, data: string) => {
    store.content = data;
  }),
}));

const getProxyPort = vi.fn(() => 12345);
vi.mock("../../proxy/credential-proxy-server.js", () => ({ getProxyPort }));

const makeIssue = (overrides: Record<string, unknown> = {}) => ({
  number: 1,
  title: "テストIssue",
  user: { login: "shin902" },
  updated_at: "2024-01-02T10:00:00Z",
  ...overrides,
});

function makeCtx(overrides: Partial<CronContext> = {}): CronContext {
  return {
    id: "issue-triage",
    schedule: "0 * * * *",
    enabled: true,
    channelId: "channel-1",
    groupName: "issue-triage",
    appendInbox: vi.fn(async () => undefined),
    client: {} as CronContext["client"],
    settings: { owner: "shin902", repo: "my-discord-agent" },
    ...overrides,
  } as CronContext;
}

describe("issue-triage handler", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    store = { content: null };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("channelId が無ければ何もしない", async () => {
    const { default: handler } = await import("./issue-triage.js");
    await handler(makeCtx({ channelId: undefined }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("groupName が無ければ何もしない", async () => {
    const { default: handler } = await import("./issue-triage.js");
    await handler(makeCtx({ groupName: undefined }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("settings が不正なら何もしない", async () => {
    const { default: handler } = await import("./issue-triage.js");
    await handler(makeCtx({ settings: { owner: "shin902" } }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("オーナー以外の投稿者によるIssueは処理対象から除外する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ user: { login: "mallory" } })],
    });
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("allowedAuthors に含まれる投稿者のIssueは処理対象にする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ user: { login: "bob" } })],
    });
    const { default: handler } = await import("./issue-triage.js");
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
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
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
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("updated_at が変化していないIssueは再処理しない", async () => {
    store.content = JSON.stringify({
      "shin902/my-discord-agent#1": "2024-01-02T10:00:00Z",
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("updated_at が変化していれば再処理する", async () => {
    store.content = JSON.stringify({
      "shin902/my-discord-agent#1": "2024-01-01T00:00:00Z",
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(1);
  });

  it("処理後に state.json を保存する", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [makeIssue()] });
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
    expect(store.content).not.toBeNull();
    const saved = JSON.parse(store.content as string);
    expect(saved["shin902/my-discord-agent#1"]).toBe("2024-01-02T10:00:00Z");
  });

  it("GitHub API エラー時は appendInbox を呼ばない", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Server Error",
    });
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
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
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx();
    await handler(ctx);
    expect(ctx.appendInbox).toHaveBeenCalledTimes(101);
    // page1(100件、満杯のため継続) -> page2(1件、PER_PAGE未満のため終了)
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("不正な owner/repo はエラーになり appendInbox を呼ばない", async () => {
    const { default: handler } = await import("./issue-triage.js");
    const ctx = makeCtx({
      settings: { owner: "..", repo: "my-discord-agent" },
    });
    await handler(ctx);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ctx.appendInbox).not.toHaveBeenCalled();
  });

  it("大文字小文字が違うユーザー名でも owner として許可される", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [makeIssue({ user: { login: "SHIN902" } })],
    });
    const { default: handler } = await import("./issue-triage.js");
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
    const { default: handler } = await import("./issue-triage.js");
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
    const { default: handler } = await import("./issue-triage.js");
    const appendInbox = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("fail"));
    const ctx = makeCtx({ appendInbox });
    await handler(ctx);
    expect(appendInbox).toHaveBeenCalledTimes(2);
    const saved = JSON.parse(store.content as string);
    // Issue #1 の appendInbox は成功しているため、#2 が失敗してもstateに残る
    expect(saved["shin902/my-discord-agent#1"]).toBe("2024-01-02T10:00:00Z");
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
    const { default: handler } = await import("./issue-triage.js");
    const ctxA = makeCtx({
      settings: { owner: "shin902", repo: "repo-a" },
      appendInbox: vi.fn(async () => undefined),
    });
    const ctxB = makeCtx({
      settings: { owner: "shin902", repo: "repo-b" },
      appendInbox: vi.fn(async () => undefined),
    });
    await Promise.all([handler(ctxA), handler(ctxB)]);
    const saved = JSON.parse(store.content as string);
    expect(saved["shin902/repo-a#1"]).toBe("2024-01-02T10:00:00Z");
    expect(saved["shin902/repo-b#1"]).toBe("2024-01-02T11:00:00Z");
  });
});
