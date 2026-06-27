import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  loadRawConfig: vi.fn(),
}));

describe("loadRequestTimeoutMs", () => {
  let loadRequestTimeoutMs: () => Promise<number>;
  let mockLoadRawConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const configMod = await import("./config.js");
    mockLoadRawConfig = vi.mocked(configMod.loadRawConfig);
    mockLoadRawConfig.mockResolvedValue({});

    ({ loadRequestTimeoutMs } = await import("./proxy-config.js"));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("デフォルトは 120000", async () => {
    expect(await loadRequestTimeoutMs()).toBe(120_000);
  });

  it("設定ファイルの requestTimeoutMs が読み込まれる", async () => {
    mockLoadRawConfig.mockResolvedValue({
      proxy: { requestTimeoutMs: 60_000 },
    });
    expect(await loadRequestTimeoutMs()).toBe(60_000);
  });

  it("設定ファイルに proxy キーがない場合はデフォルト値を返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ someOtherKey: {} });
    expect(await loadRequestTimeoutMs()).toBe(120_000);
  });

  it("設定ファイルの requestTimeoutMs が欠落していてもデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ proxy: {} });
    expect(await loadRequestTimeoutMs()).toBe(120_000);
  });

  it("requestTimeoutMs が不正な値（文字列）は warn してデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({
      proxy: { requestTimeoutMs: "60000" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadRequestTimeoutMs()).toBe(120_000);
    expect(warn).toHaveBeenCalledWith(
      "[proxy] proxy 設定が不正、デフォルト使用:",
      expect.any(String),
    );
    warn.mockRestore();
  });

  it("requestTimeoutMs が 0 以下は不正として warn しデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ proxy: { requestTimeoutMs: 0 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadRequestTimeoutMs()).toBe(120_000);
    warn.mockRestore();
  });
});
