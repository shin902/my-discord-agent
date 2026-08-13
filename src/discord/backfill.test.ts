import { ChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchChannel: vi.fn(),
  ingest: vi.fn(),
  getRepo: vi.fn(),
}));

vi.mock("./client.js", () => ({
  client: { channels: { fetch: mocks.fetchChannel } },
}));
vi.mock("./intake.js", () => ({
  ingestDiscordMessage: mocks.ingest,
}));
vi.mock("../queue/repository.js", () => ({
  getQueueRepository: mocks.getRepo,
}));

const { backfillDiscordMessages } = await import("./backfill.js");

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  errorSpy?.mockRestore();
  warnSpy?.mockRestore();
});

function message(id: string, channelId: string): Record<string, unknown> {
  return { id, channelId, createdTimestamp: Number(id) };
}

function page(messages: Record<string, unknown>[]) {
  const first = messages[0];
  return {
    size: messages.length,
    values: () => messages[Symbol.iterator](),
    first: () => first,
  };
}

function rootChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: "root-1",
    type: ChannelType.GuildText,
    messages: {
      fetch: vi.fn(),
    },
    threads: {
      fetchActive: vi.fn().mockResolvedValue({ threads: new Map() }),
      fetchArchived: vi.fn().mockResolvedValue({
        threads: new Map(),
        hasMore: false,
      }),
    },
    ...overrides,
  };
}

function forumRoot(...threads: Record<string, unknown>[]) {
  return rootChannel({
    type: ChannelType.GuildForum,
    threads: {
      fetchActive: vi.fn().mockResolvedValue({
        threads: new Map(threads.map((thread) => [thread.id, thread])),
      }),
      fetchArchived: vi.fn().mockResolvedValue({
        threads: new Map(),
        hasMore: false,
      }),
    },
  });
}

function repoWithCursors(cursors: Record<string, string>) {
  const state = new Map(Object.entries(cursors));
  return {
    getDiscordCursor: vi.fn((scope: string) => state.get(scope)),
    isDiscordCursorInitialized: vi.fn((scope: string) => state.has(scope)),
    initializeDiscordCursor: vi.fn((scope: string) => state.set(scope, "")),
    upsertDiscordCursor: vi.fn((scope: string, id: string) => {
      state.set(scope, id);
    }),
  };
}

describe("backfillDiscordMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.ingest.mockImplementation(async (input: { channelId: string }) => ({
      status: "enqueued",
      cursorScope: input.channelId,
    }));
  });

  it("親チャンネルの履歴を古い順でinbox取り込みし、カーソルを進める", async () => {
    const repo = repoWithCursors({ "root-1": "1000" });
    const root = rootChannel();
    root.messages.fetch
      .mockResolvedValueOnce(
        page([message("1002", "root-1"), message("1001", "root-1")]),
      )
      .mockResolvedValueOnce(page([]));
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "shared" }],
      },
    ]);

    expect(mocks.ingest.mock.calls.map(([input]) => input.id)).toEqual([
      "1001",
      "1002",
    ]);
    expect(root.messages.fetch).toHaveBeenNthCalledWith(1, {
      after: "1000",
      limit: 100,
      cache: false,
    });
    expect(repo.upsertDiscordCursor).toHaveBeenLastCalledWith("root-1", "1002");
  });

  it.each([
    ["Text", ChannelType.GuildText],
    ["News", ChannelType.GuildAnnouncement],
  ])("%sチャンネルの100件境界をまたぐページを継続して取得する", async (_name, type) => {
    const repo = repoWithCursors({ "root-1": "1000" });
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      message(String(1001 + index), "root-1"),
    );
    const root = rootChannel({ type });
    root.messages.fetch
      .mockResolvedValueOnce(page(firstPage))
      .mockResolvedValueOnce(page([message("1101", "root-1")]));
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "shared" }],
      },
    ]);

    expect(mocks.ingest).toHaveBeenCalledTimes(101);
    expect(root.messages.fetch).toHaveBeenNthCalledWith(1, {
      after: "1000",
      limit: 100,
      cache: false,
    });
    expect(root.messages.fetch).toHaveBeenNthCalledWith(2, {
      after: "1100",
      limit: 100,
      cache: false,
    });
    expect(repo.upsertDiscordCursor).toHaveBeenLastCalledWith("root-1", "1101");
  });

  it("バックフィル取り込み失敗時は失敗したメッセージのカーソルを進めない", async () => {
    const repo = repoWithCursors({ "root-1": "1000" });
    const root = rootChannel();
    root.messages.fetch.mockResolvedValueOnce(
      page([message("1001", "root-1")]),
    );
    mocks.ingest.mockRejectedValueOnce(new Error("enqueue failed"));
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "shared" }],
      },
    ]);

    expect(repo.getDiscordCursor("root-1")).toBe("1000");
    expect(repo.upsertDiscordCursor).not.toHaveBeenCalled();
  });

  it.each([
    ["Text", ChannelType.GuildText],
    ["News", ChannelType.GuildAnnouncement],
  ])("空の%sチャンネルを履歴なしの初期化済みとして記録する", async (_name, type) => {
    const repo = repoWithCursors({});
    const root = rootChannel({ type });
    root.messages.fetch.mockResolvedValueOnce(page([]));
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "shared" }],
      },
    ]);

    expect(repo.initializeDiscordCursor).toHaveBeenCalledWith("root-1");
    expect(repo.upsertDiscordCursor).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("初回空チャンネルの次回起動では新規メッセージを取得する", async () => {
    const repo = repoWithCursors({});
    const root = rootChannel();
    root.messages.fetch
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([message("1001", "root-1")]));
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    const groups = [
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "shared" as const }],
      },
    ];
    await backfillDiscordMessages(groups);
    await backfillDiscordMessages(groups);

    expect(root.messages.fetch).toHaveBeenNthCalledWith(1, {
      limit: 1,
      cache: false,
    });
    expect(root.messages.fetch).toHaveBeenNthCalledWith(2, {
      after: "0",
      limit: 100,
      cache: false,
    });
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "1001" }),
      { source: "backfill", replyOnFailure: false },
    );
    expect(repo.upsertDiscordCursor).toHaveBeenLastCalledWith("root-1", "1001");
  });

  it.each([
    "thread",
    "auto-thread",
    "email-mode",
  ] as const)("Forumの%sはthread単位で初回カーソルを保存する", async (sessionMode) => {
    const repo = repoWithCursors({});
    const thread = {
      id: "thread-1",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([message("2000", "thread-1")]))
          .mockResolvedValueOnce(page([])),
      },
    };
    const root = forumRoot(thread);
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode }],
      },
    ]);

    expect(root.messages.fetch).not.toHaveBeenCalled();
    expect(thread.messages.fetch).toHaveBeenNthCalledWith(1, {
      limit: 1,
      cache: false,
    });
    expect(repo.upsertDiscordCursor).toHaveBeenCalledWith("thread-1", "2000");
    expect(thread.messages.fetch).toHaveBeenNthCalledWith(2, {
      after: "2000",
      limit: 100,
      cache: false,
    });
  });

  it("Forumの既存threadカーソルから復旧し、ページ境界で継続する", async () => {
    const repo = repoWithCursors({ "thread-1": "2000" });
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      message(String(2001 + index), "thread-1"),
    );
    const thread = {
      id: "thread-1",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page(firstPage))
          .mockResolvedValueOnce(page([message("2200", "thread-1")])),
      },
    };
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(forumRoot(thread));

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" }],
      },
    ]);

    expect(thread.messages.fetch).toHaveBeenNthCalledWith(1, {
      after: "2000",
      limit: 100,
      cache: false,
    });
    expect(thread.messages.fetch).toHaveBeenNthCalledWith(2, {
      after: "2100",
      limit: 100,
      cache: false,
    });
    expect(mocks.ingest).toHaveBeenCalledTimes(101);
    expect(repo.upsertDiscordCursor).toHaveBeenLastCalledWith(
      "thread-1",
      "2200",
    );
  });

  it("Forumの初期化後に作成されたthreadは投稿と返信を下限から復旧する", async () => {
    const repo = repoWithCursors({});
    const existingThread = {
      id: "existing-thread",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([message("2000", "existing-thread")]))
          .mockResolvedValueOnce(page([]))
          .mockResolvedValue(page([])),
      },
    };
    const newThread = {
      id: "new-thread",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(
            page([
              message("3001", "new-thread"),
              message("3002", "new-thread"),
            ]),
          )
          .mockResolvedValueOnce(page([])),
      },
    };
    const firstRoot = forumRoot(existingThread);
    const secondRoot = forumRoot(existingThread, newThread);
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel
      .mockResolvedValueOnce(firstRoot)
      .mockResolvedValueOnce(secondRoot);
    const groups = [
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" as const }],
      },
    ];

    await backfillDiscordMessages(groups);
    expect(repo.isDiscordCursorInitialized("root-1")).toBe(true);
    expect(mocks.ingest).not.toHaveBeenCalled();

    await backfillDiscordMessages(groups);

    expect(newThread.messages.fetch).toHaveBeenNthCalledWith(1, {
      after: "0",
      limit: 100,
      cache: false,
    });
    expect(mocks.ingest.mock.calls.map(([input]) => input.id)).toEqual([
      "3001",
      "3002",
    ]);
    expect(repo.upsertDiscordCursor).toHaveBeenLastCalledWith(
      "new-thread",
      "3002",
    );
  });

  it("Forumのthread復旧に失敗しても種まき後に境界を保存し、再試行時の新規threadを下限から復旧する", async () => {
    const repo = repoWithCursors({});
    const existingThread = {
      id: "existing-thread",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([message("2000", "existing-thread")]))
          .mockRejectedValueOnce(new Error("temporary recovery failure"))
          .mockResolvedValueOnce(page([])),
      },
    };
    const newThread = {
      id: "new-thread",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(
            page([
              message("3001", "new-thread"),
              message("3002", "new-thread"),
            ]),
          )
          .mockResolvedValueOnce(page([])),
      },
    };
    const firstRoot = forumRoot(existingThread);
    const secondRoot = forumRoot(existingThread, newThread);
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel
      .mockResolvedValueOnce(firstRoot)
      .mockResolvedValueOnce(secondRoot);
    const groups = [
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" as const }],
      },
    ];

    await backfillDiscordMessages(groups);

    expect(repo.isDiscordCursorInitialized("root-1")).toBe(true);
    expect(repo.initializeDiscordCursor).toHaveBeenCalledWith("root-1");
    expect(
      repo.initializeDiscordCursor.mock.invocationCallOrder[0],
    ).toBeLessThan(existingThread.messages.fetch.mock.invocationCallOrder[1]);

    await backfillDiscordMessages(groups);

    expect(newThread.messages.fetch).toHaveBeenNthCalledWith(1, {
      after: "0",
      limit: 100,
      cache: false,
    });
    expect(mocks.ingest.mock.calls.map(([input]) => input.id)).toEqual([
      "3001",
      "3002",
    ]);
  });

  it("Forumの初回thread列挙が部分的なら境界を保存せず、後から見つかった既存threadを新規扱いしない", async () => {
    const repo = repoWithCursors({});
    const firstThread = {
      id: "first-thread",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([message("2000", "first-thread")]))
          .mockResolvedValue(page([])),
      },
    };
    const omittedThread = {
      id: "omitted-thread",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([message("3000", "omitted-thread")]))
          .mockResolvedValueOnce(page([])),
      },
    };
    const firstRoot = forumRoot(firstThread);
    firstRoot.threads.fetchArchived.mockRejectedValueOnce(
      new Error("temporary enumeration failure"),
    );
    const secondRoot = forumRoot(firstThread);
    secondRoot.threads.fetchArchived.mockResolvedValueOnce({
      threads: new Map([[omittedThread.id, omittedThread]]),
      hasMore: false,
    });
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel
      .mockResolvedValueOnce(firstRoot)
      .mockResolvedValueOnce(secondRoot);
    const groups = [
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" as const }],
      },
    ];

    await backfillDiscordMessages(groups);

    expect(repo.isDiscordCursorInitialized("root-1")).toBe(false);
    expect(repo.initializeDiscordCursor).not.toHaveBeenCalledWith("root-1");

    await backfillDiscordMessages(groups);

    expect(repo.isDiscordCursorInitialized("root-1")).toBe(true);
    expect(omittedThread.messages.fetch).toHaveBeenNthCalledWith(1, {
      limit: 1,
      cache: false,
    });
    expect(omittedThread.messages.fetch).not.toHaveBeenCalledWith({
      after: "0",
      limit: 100,
      cache: false,
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("Forumのthreadカーソル種まきに失敗したら境界を保存せず、完了後に保存する", async () => {
    const repo = repoWithCursors({});
    const firstThread = {
      id: "first-thread",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([message("2000", "first-thread")]))
          .mockResolvedValue(page([])),
      },
    };
    const failedThread = {
      id: "failed-thread",
      messages: {
        fetch: vi
          .fn()
          .mockRejectedValueOnce(new Error("temporary cursor failure"))
          .mockResolvedValueOnce(page([message("3000", "failed-thread")]))
          .mockResolvedValue(page([])),
      },
    };
    const root = forumRoot(firstThread, failedThread);
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);
    const groups = [
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" as const }],
      },
    ];

    await backfillDiscordMessages(groups);

    expect(repo.isDiscordCursorInitialized("root-1")).toBe(false);
    expect(repo.initializeDiscordCursor).not.toHaveBeenCalledWith("root-1");

    await backfillDiscordMessages(groups);

    expect(repo.isDiscordCursorInitialized("root-1")).toBe(true);
    const rootInitializationOrder =
      repo.initializeDiscordCursor.mock.invocationCallOrder.find(
        (order) => order > 0,
      );
    expect(rootInitializationOrder).toBeDefined();
    expect(rootInitializationOrder).toBeGreaterThan(
      Math.max(...repo.upsertDiscordCursor.mock.invocationCallOrder),
    );
  });

  it("private archived threadは参加済み取得を使い、権限不足をスタックなしで扱う", async () => {
    const repo = repoWithCursors({ "root-1": "1000" });
    const root = rootChannel();
    root.threads.fetchArchived
      .mockResolvedValueOnce({ threads: new Map(), hasMore: false })
      .mockRejectedValueOnce(
        Object.assign(new Error("Missing Access"), { code: 50001 }),
      );
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" }],
      },
    ]);

    expect(root.threads.fetchArchived).toHaveBeenNthCalledWith(
      1,
      { type: "public", fetchAll: true },
      false,
    );
    expect(root.threads.fetchArchived).toHaveBeenNthCalledWith(
      2,
      { type: "private", fetchAll: false },
      false,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "[discord-backfill] private archived threadの取得に失敗しました:",
      expect.objectContaining({ code: 50001 }),
    );
  });

  it("Forumの空threadを初期化し、次回起動で新規投稿を取得する", async () => {
    const repo = repoWithCursors({});
    const thread = {
      id: "thread-1",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([]))
          .mockResolvedValueOnce(page([message("4001", "thread-1")])),
      },
    };
    const root = forumRoot(thread);
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);
    const groups = [
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" as const }],
      },
    ];

    await backfillDiscordMessages(groups);
    expect(repo.initializeDiscordCursor).toHaveBeenCalledWith("thread-1");
    expect(mocks.ingest).not.toHaveBeenCalled();

    await backfillDiscordMessages(groups);
    expect(thread.messages.fetch).toHaveBeenNthCalledWith(2, {
      after: "0",
      limit: 100,
      cache: false,
    });
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "4001", channelId: "thread-1" }),
      { source: "backfill", replyOnFailure: false },
    );
  });

  it("threadモードは新規を含むスレッド履歴をスレッドカーソルから復旧する", async () => {
    const repo = repoWithCursors({ "root-1": "1000", "thread-1": "2000" });
    const thread = {
      id: "thread-1",
      messages: {
        fetch: vi
          .fn()
          .mockResolvedValueOnce(page([message("2002", "thread-1")]))
          .mockResolvedValueOnce(page([])),
      },
    };
    const root = rootChannel({
      threads: {
        fetchActive: vi.fn().mockResolvedValue({
          threads: new Map([[thread.id, thread]]),
        }),
        fetchArchived: vi.fn().mockResolvedValue({
          threads: new Map(),
          hasMore: false,
        }),
      },
    });
    mocks.getRepo.mockReturnValue(repo);
    mocks.fetchChannel.mockResolvedValue(root);

    await backfillDiscordMessages([
      {
        name: "group",
        channels: [{ channelId: "root-1", sessionMode: "thread" }],
      },
    ]);

    expect(thread.messages.fetch).toHaveBeenCalledWith({
      after: "2000",
      limit: 100,
      cache: false,
    });
    expect(mocks.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ id: "2002", channelId: "thread-1" }),
      { source: "backfill", replyOnFailure: false },
    );
  });
});
