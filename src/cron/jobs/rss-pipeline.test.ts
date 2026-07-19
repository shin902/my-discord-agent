import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listUnreadArticles, openRssDb } from "../../rss/store.js";
import type { CronContext } from "../runner.js";
import collectHandler from "./rss-collect.js";
import dispatchHandler from "./rss-dispatch.js";

const { validateModelMock } = vi.hoisted(() => ({
  validateModelMock: vi.fn(async () => undefined),
}));

vi.mock("../../agent/model.js", () => ({
  validateModel: validateModelMock,
}));

let tmpDir: string;
let statePath: string;
let fetchMock: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

const initialXml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Feed</title>
  <item><guid>old-1</guid><title>既存記事</title><link>https://example.com/old</link><description>既存の概要</description></item>
</channel></rss>`;

const updatedXml = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Feed</title>
  <item><guid>new-1</guid><title>新着記事</title><link>https://example.com/new</link><description>新着の概要</description></item>
  <item><guid>old-1</guid><title>既存記事</title><link>https://example.com/old</link><description>既存の概要</description></item>
</channel></rss>`;

function mockFeed(xml: string): void {
  fetchMock.mockResolvedValueOnce(
    new Response(xml, {
      status: 200,
      headers: {
        "content-type": "application/rss+xml",
        etag: '"feed-v1"',
      },
    }),
  );
}

function makeCollectCtx(
  bootstrap: "mark-seen" | "process" = "mark-seen",
  feedName?: string,
): CronContext {
  return {
    id: "rss-collect",
    schedule: "15m",
    enabled: true,
    handler: "jobs/rss-collect.ts",
    settings: {
      feeds: [
        feedName
          ? { url: "https://example.com/feed.xml", name: feedName }
          : "https://example.com/feed.xml",
      ],
      statePath,
      bootstrap,
    },
    appendInbox: vi.fn(async () => undefined),
    client: {} as CronContext["client"],
  };
}

function makeDispatchCtx(
  appendInbox: CronContext["appendInbox"],
  maxItemsPerRun = 10,
): CronContext {
  return {
    id: "rss-dispatch",
    schedule: "15m",
    enabled: true,
    handler: "jobs/rss-dispatch.ts",
    groupName: "rss",
    channelId: "channel-1",
    deliveryMode: "direct",
    sessionMode: "per-run",
    tools: ["bash"],
    skills: ["agent-reach"],
    settings: { statePath, maxItemsPerRun },
    appendInbox,
    client: {} as CronContext["client"],
  };
}

function unreadTitles(): string[] {
  const db = openRssDb(statePath);
  try {
    return listUnreadArticles(db, 100).map((article) => article.title);
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "rss-pipeline-test-"));
  statePath = join(tmpDir, "rss.sqlite3");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  validateModelMock.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  logSpy.mockRestore();
  errorSpy.mockRestore();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("RSS collect / dispatch", () => {
  it("初回を既読で保存し、新着だけをinbox投入後に既読化する", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx());
    expect(unreadTitles()).toEqual([]);

    mockFeed(updatedXml);
    await collectHandler(makeCollectCtx());
    expect(unreadTitles()).toEqual(["新着記事"]);

    const appendInbox = vi.fn(async () => undefined);
    await dispatchHandler(makeDispatchCtx(appendInbox));

    expect(appendInbox).toHaveBeenCalledTimes(1);
    expect(appendInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "channel-1",
        groupName: "rss",
        content: expect.stringContaining("新着記事"),
        configOverride: {
          tools: ["bash"],
          skills: ["agent-reach"],
        },
      }),
    );
    const content = (appendInbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .content;
    expect(content).toContain("必ず agent-reach を使って内容を取得");
    expect(content).toContain("RSS概要（URL取得失敗時のフォールバック）");
    expect(unreadTitles()).toEqual([]);
  });

  it("promptを上書きしてもagent-reachによる取得ルールを維持する", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.prompt = "独自の形式で要約してください";

    await dispatchHandler(ctx);

    const content = (appendInbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .content;
    expect(content).toContain("独自の形式で要約してください");
    expect(content).toContain("必ず agent-reach を使って内容を取得");
  });

  it("inbox投入に失敗した記事は未読のまま残す", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => {
      throw new Error("inbox unavailable");
    });

    await expect(dispatchHandler(makeDispatchCtx(appendInbox))).rejects.toThrow(
      "inbox unavailable",
    );
    expect(unreadTitles()).toEqual(["既存記事"]);
  });

  it("不明なツールが指定されている場合はinbox投入せず未読のまま残す", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.tools = ["unknown-tool"];

    await expect(dispatchHandler(ctx)).rejects.toThrow("不明なツール名");
    expect(appendInbox).not.toHaveBeenCalled();
    expect(unreadTitles()).toEqual(["既存記事"]);
  });

  it("不明なモデルが指定されている場合はinbox投入せず未読のまま残す", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    validateModelMock.mockRejectedValueOnce(new Error("不明なモデル"));
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.model = { provider: "unknown-provider", modelId: "unknown-model" };

    await expect(dispatchHandler(ctx)).rejects.toThrow("不明なモデル");
    expect(appendInbox).not.toHaveBeenCalled();
    expect(unreadTitles()).toEqual(["既存記事"]);
  });

  it("不明なスキルが指定されている場合はinbox投入せず未読のまま残す", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.skills = ["unknown-skill"];

    await expect(dispatchHandler(ctx)).rejects.toThrow(
      "allowlist に指定されたスキル",
    );
    expect(appendInbox).not.toHaveBeenCalled();
    expect(unreadTitles()).toEqual(["既存記事"]);
  });

  it("今回inboxへ投入した件数だけを既読にする", async () => {
    mockFeed(updatedXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => undefined);

    await dispatchHandler(makeDispatchCtx(appendInbox, 1));

    expect(appendInbox).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("新着記事") }),
    );
    expect(unreadTitles()).toEqual(["既存記事"]);
  });

  it("ETag取得後は条件付きリクエストを送る", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx());
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));

    await collectHandler(makeCollectCtx());

    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://example.com/feed.xml",
      expect.objectContaining({
        headers: expect.objectContaining({ "If-None-Match": '"feed-v1"' }),
      }),
    );
  });

  it("304でも変更した設定名を保存する", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process", "旧フィード名"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 304 }));

    await collectHandler(makeCollectCtx("process", "新フィード名"));

    const db = openRssDb(statePath);
    try {
      expect(listUnreadArticles(db, 1)[0]?.feedName).toBe("新フィード名");
    } finally {
      db.close();
    }
  });
});
