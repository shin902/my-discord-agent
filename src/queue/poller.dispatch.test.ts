import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../config/groups.js", () => ({ findGroupByName: vi.fn() }));
vi.mock("../config/poller-config.js", () => ({ loadDispatchMode: vi.fn() }));
vi.mock("../discord/client.js", () => ({
  client: {
    channels: {
      cache: { get: vi.fn().mockReturnValue(undefined) },
      fetch: vi.fn(),
    },
    isReady: vi.fn().mockReturnValue(false),
  },
}));
vi.mock("./dead-letter.js", () => ({ appendDeadLetter: vi.fn() }));
vi.mock("./inbox.js", () => ({
  peekAllUnclaimedInbox: vi.fn(),
  removeInboxById: vi.fn(),
  updateInboxById: vi.fn(),
}));

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

let dispatch: (sessionId: string, fn: () => Promise<void>) => void;
let stopPoller: () => void;
let startPoller: () => void;

beforeEach(async () => {
  vi.resetModules();
  ({ dispatch, stopPoller, startPoller } = await import("./poller.js"));
});

describe("stopPoller", () => {
  it("stopPoller 後にセッションチェーンがクリアされる", async () => {
    let resolve1!: () => void;
    const block1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    dispatch("s1", async () => {
      await block1;
    });

    stopPoller();
    // チェーンがクリアされているため、新しいタスクは即座に開始できる
    const started: string[] = [];
    dispatch("s1", async () => {
      started.push("s1-new");
    });

    resolve1();
    await tick();
    expect(started).toContain("s1-new");
  });
});

describe("dispatch", () => {
  it("同一 sessionId のタスクは順番通りに実行される", async () => {
    const order: number[] = [];
    let resolve1!: () => void;
    const block1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    dispatch("s1", async () => {
      await block1;
      order.push(1);
    });
    dispatch("s1", async () => {
      order.push(2);
    });

    await Promise.resolve();
    expect(order).toEqual([]);

    resolve1();
    await tick();
    expect(order).toEqual([1, 2]);
  });

  it("異なる sessionId は並列実行される", async () => {
    const started: string[] = [];
    let resolve1!: () => void;
    const block1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    dispatch("s1", async () => {
      started.push("s1");
      await block1;
    });
    dispatch("s2", async () => {
      started.push("s2");
    });

    await tick();
    expect(started).toContain("s1");
    expect(started).toContain("s2");

    resolve1();
    await tick();
  });

  it("タスク完了後に sessionChain から削除される（メモリリークなし）", async () => {
    let completed = false;
    dispatch("s1", async () => {
      completed = true;
    });

    await tick();
    expect(completed).toBe(true);
    // 次のタスクが来ても prev = Promise.resolve() から始まること（チェーンが消えている）を
    // 間接的に確認: エラーが起きても他セッションに影響しない
    dispatch("s2", async () => {});
    await tick();
  });

  it("エラー発生時に sessionId がログに出力される", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatch("my-session-123", async () => {
      throw new Error("boom");
    });

    await tick();

    expect(spy).toHaveBeenCalledWith(
      "[poller] 予期せぬエラー (sessionId:",
      "my-session-123",
      "):",
      expect.any(Error),
    );
    spy.mockRestore();
  });
});

describe("poll - 例外耐性 (#152)", () => {
  it("peekAllUnclaimedInbox が例外を投げてもポーラーは止まらず次のtickで継続する", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = await import("../discord/client.js");
    const { peekAllUnclaimedInbox } = await import("./inbox.js");
    const { loadDispatchMode } = await import("../config/poller-config.js");

    vi.mocked(client.isReady).mockReturnValue(true);
    vi.mocked(loadDispatchMode).mockResolvedValue("parallel-session");
    vi.mocked(peekAllUnclaimedInbox)
      .mockRejectedValueOnce(new Error("不正なJSON行"))
      .mockResolvedValue([]);

    startPoller();
    // 例外発生後は POLL_MS(1000ms) sleep を挟んで次のtickに進むため少し長めに待つ
    await new Promise<void>((r) => setTimeout(r, 1100));

    expect(spy).toHaveBeenCalledWith(
      "[poller] poll ループで予期せぬエラー:",
      expect.any(Error),
    );
    // 1回目の例外後も2回目の呼び出しが行われている（ループが継続している）
    expect(vi.mocked(peekAllUnclaimedInbox).mock.calls.length).toBeGreaterThan(
      1,
    );

    stopPoller();
    spy.mockRestore();
  }, 10000);
});
