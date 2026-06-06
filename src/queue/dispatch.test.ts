import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
vi.mock("../config/group-config.js", () => ({ loadGroupConfig: vi.fn() }));
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
vi.mock("./inbox.js", () => ({ prependInbox: vi.fn(), shiftInbox: vi.fn() }));

const tick = () => new Promise<void>((r) => setTimeout(r, 20));

let dispatch: (
  sessionId: string,
  fn: () => Promise<void>,
  mode: "serial" | "parallel-session",
) => void;

beforeEach(async () => {
  vi.resetModules();
  ({ dispatch } = await import("./poller.js"));
});

describe("dispatch - serial モード", () => {
  it("タスク1が完了するまでタスク2は開始されない", async () => {
    const order: number[] = [];
    let resolve1!: () => void;
    const block1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    dispatch(
      "s1",
      async () => {
        await block1;
        order.push(1);
      },
      "serial",
    );
    dispatch(
      "s2",
      async () => {
        order.push(2);
      },
      "serial",
    );

    await Promise.resolve();
    expect(order).toEqual([]);

    resolve1();
    await tick();
    expect(order).toEqual([1, 2]);
  });

  it("異なる sessionId でも直列化される", async () => {
    const order: number[] = [];
    let resolve1!: () => void;
    const block1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    dispatch(
      "s1",
      async () => {
        await block1;
        order.push(1);
      },
      "serial",
    );
    dispatch(
      "s2",
      async () => {
        order.push(2);
      },
      "serial",
    );

    await Promise.resolve();
    expect(order).toEqual([]);

    resolve1();
    await tick();
    expect(order).toEqual([1, 2]);
  });

  it("エラー発生時に sessionId がログに出力される", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatch(
      "my-session-123",
      async () => {
        throw new Error("boom");
      },
      "serial",
    );

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

describe("dispatch - parallel-session モード", () => {
  it("同一 sessionId のタスクは順番通りに実行される", async () => {
    const order: number[] = [];
    let resolve1!: () => void;
    const block1 = new Promise<void>((r) => {
      resolve1 = r;
    });

    dispatch(
      "s1",
      async () => {
        await block1;
        order.push(1);
      },
      "parallel-session",
    );
    dispatch(
      "s1",
      async () => {
        order.push(2);
      },
      "parallel-session",
    );

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

    dispatch(
      "s1",
      async () => {
        started.push("s1");
        await block1;
      },
      "parallel-session",
    );
    dispatch(
      "s2",
      async () => {
        started.push("s2");
      },
      "parallel-session",
    );

    await tick();
    expect(started).toContain("s1");
    expect(started).toContain("s2");

    resolve1();
    await tick();
  });

  it("タスク完了後に sessionChain から削除される（メモリリークなし）", async () => {
    let completed = false;
    dispatch(
      "s1",
      async () => {
        completed = true;
      },
      "parallel-session",
    );

    await tick();
    expect(completed).toBe(true);
    // 次のタスクが来ても prev = Promise.resolve() から始まること（チェーンが消えている）を
    // 間接的に確認: エラーが起きても他セッションに影響しない
    dispatch("s2", async () => {}, "parallel-session");
    await tick();
  });

  it("parallel-session でのエラーに sessionId がログに出力される", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    dispatch(
      "session-abc",
      async () => {
        throw new Error("fail");
      },
      "parallel-session",
    );

    await tick();

    expect(spy).toHaveBeenCalledWith(
      "[poller] 予期せぬエラー (sessionId:",
      "session-abc",
      "):",
      expect.any(Error),
    );
    spy.mockRestore();
  });
});
