import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getFeedState,
  listUnreadArticles,
  openRssDb,
  saveFeedEntries,
} from "../../rss/store.js";
import { NonRetryableError } from "../../utils/error.js";
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
    prompt: "RSS記事を日本語で要約してください",
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

function saveUnreadFeed(
  url: string,
  configuredName: string,
  entries: Parameters<typeof saveFeedEntries>[1]["entries"],
): void {
  const db = openRssDb(statePath);
  try {
    saveFeedEntries(db, {
      url,
      configuredName,
      parsedName: "",
      etag: null,
      lastModified: null,
      entries,
      markInitialAsRead: false,
    });
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
  it("collectのsettingsが不正ならNonRetryableErrorを投げる", async () => {
    const ctx = makeCollectCtx();
    ctx.settings = { statePath };

    await expect(collectHandler(ctx)).rejects.toBeInstanceOf(NonRetryableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("dispatchのsettingsが不正ならNonRetryableErrorを投げる", async () => {
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.settings = { statePath, maxItemsPerRun: 0 };

    await expect(dispatchHandler(ctx)).rejects.toBeInstanceOf(
      NonRetryableError,
    );
    expect(appendInbox).not.toHaveBeenCalled();
  });

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
    expect(content).toContain("RSS記事を日本語で要約してください");
    expect(content).toContain("RSS概要:");
    expect(unreadTitles()).toEqual([]);
  });

  it("多数の記事を件数で切り捨てず保存する", async () => {
    const itemCount = 205;
    const items = Array.from(
      { length: itemCount },
      (_, index) =>
        `<item><guid>item-${index}</guid><title>記事${index}</title></item>`,
    ).join("");
    mockFeed(
      `<?xml version="1.0"?><rss version="2.0"><channel><title>Many Items</title>${items}</channel></rss>`,
    );

    await collectHandler(makeCollectCtx("process"));

    const db = openRssDb(statePath);
    try {
      expect(listUnreadArticles(db, itemCount + 1)).toHaveLength(itemCount);
    } finally {
      db.close();
    }
  });

  it("記事保存の途中で失敗した場合はフィードを含めて全件ロールバックする", () => {
    const feedUrl = "https://example.com/atomic.xml";
    const db = openRssDb(statePath);
    try {
      db.exec(`
        CREATE TEMP TRIGGER fail_second_article
        BEFORE INSERT ON rss_articles
        WHEN NEW.entry_id = 'fail'
        BEGIN
          SELECT RAISE(ABORT, 'forced test failure');
        END
      `);

      expect(() =>
        saveFeedEntries(db, {
          url: feedUrl,
          parsedName: "Atomic Feed",
          etag: '"atomic-v1"',
          lastModified: null,
          entries: [
            {
              entryId: "first",
              title: "先に保存される記事",
              link: "https://example.com/first",
              publishedAt: "",
              summary: "",
            },
            {
              entryId: "fail",
              title: "保存に失敗する記事",
              link: "https://example.com/fail",
              publishedAt: "",
              summary: "",
            },
          ],
          markInitialAsRead: false,
        }),
      ).toThrow("forced test failure");

      expect(getFeedState(db, feedUrl)).toBeUndefined();
      expect(listUnreadArticles(db, 10)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("ユーザー指定のpromptへ固定の取得指示を追加しない", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.prompt = "独自の形式で要約してください";

    await dispatchHandler(ctx);

    const content = (appendInbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .content;
    expect(content).toContain("独自の形式で要約してください");
    expect(content).not.toContain("必ず agent-reach を使って内容を取得");
    expect(content).not.toContain("信頼できない外部コンテンツ");
  });

  it.each([
    undefined,
    "",
    "   ",
  ])("promptが未指定または空の場合はinbox投入せず未読のまま残す: %s", async (prompt) => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.prompt = prompt;

    await expect(dispatchHandler(ctx)).rejects.toThrow(
      "promptが設定されていません",
    );
    expect(appendInbox).not.toHaveBeenCalled();
    expect(unreadTitles()).toEqual(["既存記事"]);
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

  it("settings.feedsで指定したフィードの記事だけを並列dispatchする", async () => {
    saveUnreadFeed("https://example.com/note.xml", "ゆいまる", [
      {
        entryId: "note-1",
        title: "note記事",
        link: "https://example.com/note/1",
        publishedAt: "2026-07-22T00:00:00.000Z",
        summary: "note概要",
      },
    ]);
    saveUnreadFeed("https://example.com/youtube.xml", "AI整体師", [
      {
        entryId: "youtube-1",
        title: "YouTube動画",
        link: "https://example.com/youtube/1",
        publishedAt: "2026-07-22T01:00:00.000Z",
        summary: "動画概要",
      },
    ]);
    const noteInbox = vi.fn(async () => undefined);
    const youtubeInbox = vi.fn(async () => undefined);
    const noteCtx = makeDispatchCtx(noteInbox);
    noteCtx.settings = {
      statePath,
      feeds: [{ name: "ゆいまる", url: "https://example.com/note.xml" }],
    };
    const youtubeCtx = makeDispatchCtx(youtubeInbox);
    youtubeCtx.settings = {
      statePath,
      feeds: ["https://example.com/youtube.xml"],
    };

    await Promise.all([dispatchHandler(noteCtx), dispatchHandler(youtubeCtx)]);

    const noteContent = (noteInbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .content;
    const youtubeContent = (youtubeInbox as ReturnType<typeof vi.fn>).mock
      .calls[0][0].content;
    expect(noteContent).toContain("note記事");
    expect(noteContent).not.toContain("YouTube動画");
    expect(youtubeContent).toContain("YouTube動画");
    expect(youtubeContent).not.toContain("note記事");
    expect(unreadTitles()).toEqual([]);
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

  it("フィード取得を最大4件まで並列実行する", async () => {
    const urls = Array.from(
      { length: 5 },
      (_, index) => `https://example.com/feed-${index}.xml`,
    );
    const pending: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          pending.push(() => {
            active--;
            resolve(
              new Response(initialXml, {
                headers: { "content-type": "application/rss+xml" },
              }),
            );
          });
        }),
    );
    const ctx = makeCollectCtx("process");
    ctx.settings = { feeds: urls, statePath, bootstrap: "process" };

    const collecting = collectHandler(ctx);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(maxActive).toBe(4);

    for (const release of pending.splice(0)) release();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(maxActive).toBe(4);
    pending.shift()?.();
    await collecting;
  });

  it("inboxへ追加する外部フィールドをそれぞれ切り詰める", async () => {
    saveUnreadFeed(
      `https://feed.example/${"u".repeat(5_000)}`,
      "f".repeat(1_000),
      [
        {
          entryId: "large-fields",
          title: "t".repeat(1_000),
          link: `https://article.example/${"l".repeat(5_000)}`,
          publishedAt: "p".repeat(1_000),
          summary: "概要",
        },
      ],
    );
    const appendInbox = vi.fn(async () => undefined);

    await dispatchHandler(makeDispatchCtx(appendInbox));

    const content = (appendInbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .content;
    expect(content).toContain(`フィード: ${"f".repeat(200)} (`);
    expect(content).not.toContain("f".repeat(201));
    expect(content).toContain(`タイトル: ${"t".repeat(500)}`);
    expect(content).not.toContain("t".repeat(501));
    expect(content).not.toContain("u".repeat(2_049));
    expect(content).not.toContain("l".repeat(2_049));
    expect(content).not.toContain("p".repeat(101));
    expect(content.length).toBeLessThanOrEqual(64_000);
  });

  it("inboxの総量上限に入った記事だけを既読にする", async () => {
    saveUnreadFeed(
      "https://example.com/large-feed.xml",
      "Large Feed",
      Array.from({ length: 10 }, (_, index) => ({
        entryId: `large-${index}`,
        title: `記事${index}`,
        link: `https://example.com/articles/${index}`,
        publishedAt: "",
        summary: "s".repeat(12_000),
      })),
    );
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox, 10);
    ctx.settings = {
      statePath,
      maxItemsPerRun: 10,
      maxSummaryChars: 12_000,
    };

    await dispatchHandler(ctx);

    const content = (appendInbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .content;
    const queuedCount = content.match(/^## RSS記事 /gm)?.length ?? 0;
    expect(content.length).toBeLessThanOrEqual(64_000);
    expect(queuedCount).toBeGreaterThan(0);
    expect(queuedCount).toBeLessThan(10);
    expect(unreadTitles()).toHaveLength(10 - queuedCount);
  });

  it("先頭記事が入らなくても容量内の後続記事を投入する", async () => {
    saveUnreadFeed("https://example.com/mixed-feed.xml", "Mixed Feed", [
      {
        entryId: "large",
        title: "大きい記事",
        link: "https://example.com/large",
        publishedAt: "",
        summary: "s".repeat(12_000),
      },
      {
        entryId: "small",
        title: "小さい記事",
        link: "https://example.com/small",
        publishedAt: "",
        summary: "短い概要",
      },
    ]);
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.prompt = "p".repeat(55_000);
    ctx.settings = {
      statePath,
      maxItemsPerRun: 10,
      maxSummaryChars: 12_000,
    };

    await dispatchHandler(ctx);

    const content = (appendInbox as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .content;
    expect(content).not.toContain("大きい記事");
    expect(content).toContain("小さい記事");
    expect(unreadTitles()).toEqual(["大きい記事"]);
  });

  it("promptが長すぎて1件も入らない場合は未読のまま設定エラーにする", async () => {
    mockFeed(initialXml);
    await collectHandler(makeCollectCtx("process"));
    const appendInbox = vi.fn(async () => undefined);
    const ctx = makeDispatchCtx(appendInbox);
    ctx.prompt = "p".repeat(64_000);

    await expect(dispatchHandler(ctx)).rejects.toThrow(
      "promptが長すぎてinboxの文字数上限内に記事を追加できません",
    );
    expect(appendInbox).not.toHaveBeenCalled();
    expect(unreadTitles()).toEqual(["既存記事"]);
  });
});
