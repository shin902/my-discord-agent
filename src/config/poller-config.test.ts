import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  loadRawConfig: vi.fn(),
}));

describe("loadDispatchMode", () => {
  let loadDispatchMode: () => Promise<"serial" | "parallel-session">;
  let mockLoadRawConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.POLLER_DISPATCH_MODE;

    const configMod = await import("./config.js");
    mockLoadRawConfig = vi.mocked(configMod.loadRawConfig);
    mockLoadRawConfig.mockResolvedValue({});

    ({ loadDispatchMode } = await import("./poller-config.js"));
  });

  afterEach(() => {
    delete process.env.POLLER_DISPATCH_MODE;
  });

  it("デフォルトは parallel-session", async () => {
    expect(await loadDispatchMode()).toBe("parallel-session");
  });

  it("設定ファイルの dispatchMode が読み込まれる", async () => {
    mockLoadRawConfig.mockResolvedValue({ poller: { dispatchMode: "serial" } });
    expect(await loadDispatchMode()).toBe("serial");
  });

  it("環境変数が設定ファイルより優先される", async () => {
    process.env.POLLER_DISPATCH_MODE = "serial";
    mockLoadRawConfig.mockResolvedValue({ poller: { dispatchMode: "parallel-session" } });
    expect(await loadDispatchMode()).toBe("serial");
  });

  it("環境変数 parallel-session も正しく読まれる", async () => {
    process.env.POLLER_DISPATCH_MODE = "parallel-session";
    mockLoadRawConfig.mockResolvedValue({ poller: { dispatchMode: "serial" } });
    expect(await loadDispatchMode()).toBe("parallel-session");
  });

  it("設定ファイルに poller キーがない場合はデフォルト値を返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ someOtherKey: {} });
    expect(await loadDispatchMode()).toBe("parallel-session");
  });
});
