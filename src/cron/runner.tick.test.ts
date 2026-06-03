import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tick() のオーケストレーションテスト
// _jobs / _state はモジュールレベルキャッシュのため vi.resetModules() + vi.doMock() パターンを使用

const CHANNEL_JOB = JSON.stringify([
  {
    id: "tick-job",
    schedule: "* * * * *",
    groupName: "g",
    prompt: "p",
    channelId: "c",
    mode: "channel",
  },
]);

describe("tick() orchestration", () => {
  let mockAppendInbox: ReturnType<typeof vi.fn>;
  let mockIsReady: ReturnType<typeof vi.fn>;
  let mockExistsSync: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockWriteFile: ReturnType<typeof vi.fn>;
  let startCron: () => void;
  let stopCron: () => void;

  beforeEach(async () => {
    // 12:29:50 = 次の分境界まで10秒
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-15T12:29:50.000Z"));

    mockAppendInbox = vi.fn().mockResolvedValue(undefined);
    mockIsReady = vi.fn().mockReturnValue(true);
    mockExistsSync = vi.fn();
    mockReadFile = vi.fn().mockResolvedValue(CHANNEL_JOB);
    mockWriteFile = vi.fn().mockResolvedValue(undefined);

    vi.resetModules();
    vi.doMock("node:fs", () => ({ existsSync: mockExistsSync }));
    vi.doMock("node:fs/promises", () => ({
      readFile: mockReadFile,
      writeFile: mockWriteFile,
      mkdir: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../discord/client.js", () => ({
      client: { isReady: mockIsReady, channels: { fetch: vi.fn() } },
    }));
    vi.doMock("../queue/inbox.js", () => ({ appendInbox: mockAppendInbox }));
    vi.doMock("../agent/manager.js", () => ({ sendMessage: vi.fn() }));
    vi.doMock("../utils/splitMessage.js", () => ({
      splitMessage: (s: string) => [s],
    }));

    // cron-jobs.json は存在する、state.json は存在しない
    mockExistsSync.mockImplementation(
      (p: unknown) => typeof p === "string" && p.includes("cron-jobs.json"),
    );

    const runner = await import("./runner.js");
    startCron = runner.startCron;
    stopCron = runner.stopCron;
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

  it("cron-jobs.json がない場合 tick は何も実行しない", async () => {
    mockExistsSync.mockReturnValue(false);
    startCron();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mockAppendInbox).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
