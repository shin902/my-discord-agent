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

let logSpy: ReturnType<typeof vi.spyOn>;

afterEach(() => {
  logSpy?.mockRestore();
});

function message(id: string, channelId: string): Record<string, unknown> {
  return { id, channelId, createdTimestamp: Number(id) };
}

function page(messages: Record<string, unknown>[]) {
  return {
    size: messages.length,
    values: () => messages[Symbol.iterator](),
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

function repoWithCursors(cursors: Record<string, string>) {
  const state = new Map(Object.entries(cursors));
  return {
    getDiscordCursor: vi.fn((scope: string) => state.get(scope)),
    upsertDiscordCursor: vi.fn((scope: string, id: string) => {
      state.set(scope, id);
    }),
  };
}

describe("backfillDiscordMessages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
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
    expect(logSpy).toHaveBeenCalledWith(
      "[discord-backfill] channel=root-1 group=group startupBackfill.enabled=true source=default",
    );
  });

  it("enabled=false はチャンネル単位で復旧を無効化し、判定結果をログに出す", async () => {
    const repo = repoWithCursors({});
    mocks.getRepo.mockReturnValue(repo);

    await backfillDiscordMessages([
      {
        name: "disabled-group",
        channels: [
          {
            channelId: "disabled-channel",
            sessionMode: "shared",
            startupBackfill: { enabled: false, archivedThreads: true },
          },
        ],
      },
    ]);

    expect(mocks.fetchChannel).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(
      "[discord-backfill] channel=disabled-channel group=disabled-group startupBackfill.enabled=false source=config",
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
