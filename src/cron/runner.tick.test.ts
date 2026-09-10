import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "./runner.js";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function makeJob(id: string, schedule: string, prompt = id): CronJob {
  return {
    id,
    schedule,
    enabled: true,
    groupName: "g",
    prompt,
    channelId: "c",
    deliveryMode: "direct",
    sessionMode: "per-run",
  };
}

// tick() のオーケストレーションテスト
// _jobs / _state はモジュールレベルキャッシュのため vi.resetModules() + vi.doMock() パターンを使用

describe("tick() orchestration", () => {
  let mockAppendInbox: ReturnType<typeof vi.fn>;
  let mockIsReady: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockWriteFile: ReturnType<typeof vi.fn>;
  let startCron: () => void;
  let stopCron: () => void;
  let setCronJobs: (jobs: CronJob[]) => void;

  beforeEach(async () => {
    // 12:29:50 = 次の分境界まで10秒
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:29:50.000Z"));

    mockAppendInbox = vi.fn().mockResolvedValue(undefined);
    mockIsReady = vi.fn().mockReturnValue(true);
    mockExistsSync = vi.fn();
    mockWriteFile = vi.fn().mockResolvedValue(undefined);

    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: mockExistsSync }));
    vi.doMock("node:fs/promises", () => ({
      readFile: vi.fn(),
      writeFile: mockWriteFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));
    const discordClient = {
      isReady: mockIsReady,
      channels: { fetch: vi.fn() },
    };
    vi.doMock("../discord/client.js", () => ({
      getDefaultDiscordClient: () => discordClient,
      getDiscordClientForGroupName: vi.fn().mockResolvedValue(discordClient),
      getDiscordClients: () => new Map([["personal", discordClient]]),
    }));
    vi.doMock("../queue/repository.js", () => ({
      getQueueRepository: () => ({ enqueue: mockAppendInbox }),
    }));
    vi.doMock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
    vi.doMock("../utils/splitMessage.js", () => ({
      splitMessage: (s: string) => [s],
    }));

    // state.json は存在しない
    mockExistsSync.mockReturnValue(false);

    const runner = await import("./runner.js");
    startCron = runner.startCron;
    stopCron = runner.stopCron;
    setCronJobs = runner._setCronJobs;

    // 静的ロードパターン: テストで直接 _setCronJobs を呼び出してジョブを設定
    setCronJobs([makeJob("tick-job", "* * * * *", "p")]);
  });

  afterEach(() => {
    stopCron();
    vi.useRealTimers();
    vi.resetModules();
  });

  it("client.isReady() が false の場合 tick をスキップする", async () => {
    mockIsReady.mockReturnValue(false);
    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it("マッチするジョブを実行して state.json に lastRun を保存する", async () => {
    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("state.json"),
      expect.stringContaining("tick-job"),
      "utf-8",
    );
  });

  it("一時的エラー: lastRun を更新しない（次の tick でリトライ）", async () => {
    mockAppendInbox.mockRejectedValue(new Error("some transient failure"));
    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("NonRetryableError: lastRun を更新してリトライを防止する", async () => {
    const { NonRetryableError } = await import("../utils/error.js");
    mockAppendInbox.mockRejectedValue(new NonRetryableError("bad config"));
    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("state.json"),
      expect.stringContaining("tick-job"),
      "utf-8",
    );
  });

  it("長時間実行中も次のtickをブロックせず別ジョブを実行する", async () => {
    const longRun = deferred<void>();
    mockAppendInbox.mockImplementation(async (payload: { content: string }) => {
      if (payload.content === "long") await longRun.promise;
    });
    setCronJobs([
      makeJob("long-job", "* * * * *", "long"),
      makeJob("next-job", "31 * * * *", "next"),
    ]);

    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).toHaveBeenCalledTimes(1);

    // 60秒以上経過しても long-job が終わらない間に、次のtickで next-jobを開始する。
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockAppendInbox).toHaveBeenCalledTimes(2);
    expect(
      mockAppendInbox.mock.calls.map(([payload]) => payload.content),
    ).toEqual(["long", "next"]);

    longRun.resolve(undefined);
    await flushMicrotasks();
  });

  it("遅延したtickは過去のcron slotをcatch upしない", async () => {
    setCronJobs([makeJob("delayed-job", "30 * * * *")]);
    startCron();

    // 分境界のタイマーが遅れて発火した場合、12:30のslotを12:31で再生しない。
    vi.setSystemTime(new Date("2025-01-15T12:31:00.000Z"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).not.toHaveBeenCalled();
  });

  it("intervalはadmission基準で、実行中に経過した複数回分を積算catch upしない", async () => {
    const longRun = deferred<void>();
    mockAppendInbox.mockImplementation(async (payload: { content: string }) => {
      if (payload.content === "interval") await longRun.promise;
    });
    setCronJobs([makeJob("interval-job", "1m", "interval")]);

    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(mockAppendInbox).toHaveBeenCalledTimes(1);

    longRun.resolve(undefined);
    await flushMicrotasks();
    expect(
      JSON.parse(String(mockWriteFile.mock.calls[0][1]))["interval-job"]
        .lastRun,
    ).toBe("2025-01-15T12:30:00.000Z");

    await vi.advanceTimersByTimeAsync(60_000);
    // 経過した3 intervalをまとめて再生せず、次のtickでは最大1回だけ開始する。
    expect(mockAppendInbox).toHaveBeenCalledTimes(2);
  });

  it("同一jobはhandler完了まで重複起動しない", async () => {
    const longRun = deferred<void>();
    mockAppendInbox.mockImplementation(async () => {
      await longRun.promise;
    });
    setCronJobs([makeJob("duplicate-job", "* * * * *")]);

    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(mockAppendInbox).toHaveBeenCalledOnce();

    longRun.resolve(undefined);
    await flushMicrotasks();
  });

  it("完了順が逆でもstate.jsonのjob key更新を失わない", async () => {
    const firstRun = deferred<void>();
    const secondRun = deferred<void>();
    const firstWrite = deferred<void>();
    const writes: string[] = [];
    let persisted: string | undefined;

    mockAppendInbox.mockImplementation(async (payload: { content: string }) => {
      if (payload.content === "job-a") await firstRun.promise;
      if (payload.content === "job-b") await secondRun.promise;
    });
    mockWriteFile.mockImplementation(
      async (_filePath: string, content: string) => {
        const serialized = String(content);
        writes.push(serialized);
        if (writes.length === 1) await firstWrite.promise;
        persisted = serialized;
      },
    );
    setCronJobs([
      makeJob("job-a", "* * * * *", "job-a"),
      makeJob("job-b", "* * * * *", "job-b"),
    ]);

    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).toHaveBeenCalledTimes(2);

    // job-bの保存を先に開始し、そのwrite中にjob-aが完了する。
    secondRun.resolve(undefined);
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    firstRun.resolve(undefined);
    await flushMicrotasks();
    expect(writes).toHaveLength(1);

    firstWrite.resolve(undefined);
    await flushMicrotasks();
    expect(writes).toHaveLength(2);
    expect(JSON.parse(persisted as string)).toEqual({
      "job-a": { lastRun: expect.any(String) },
      "job-b": { lastRun: expect.any(String) },
    });
  });

  it("ジョブが空配列の場合 tick は何も実行しない", async () => {
    setCronJobs([]);
    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
