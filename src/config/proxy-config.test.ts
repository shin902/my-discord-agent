import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, loadRawConfig: vi.fn() };
});

describe("loadRequestTimeoutMs", () => {
  let loadRequestTimeoutMs: () => Promise<number>;
  let mockLoadRawConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const configMod = await import("./config.js");
    mockLoadRawConfig = vi.mocked(configMod.loadRawConfig);

    ({ loadRequestTimeoutMs } = await import("./proxy-config.js"));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    {},
    { proxy: {} },
  ])("requestTimeoutMs 未指定なら120000を返す: %j", async (config) => {
    mockLoadRawConfig.mockResolvedValue(config);
    expect(await loadRequestTimeoutMs()).toBe(120_000);
  });

  it("設定ファイルの requestTimeoutMs が読み込まれる", async () => {
    mockLoadRawConfig.mockResolvedValue({
      proxy: { requestTimeoutMs: 60_000 },
    });
    expect(await loadRequestTimeoutMs()).toBe(60_000);
  });

  it.each([
    { category: "non-number", requestTimeoutMs: "60000" },
    { category: "non-positive", requestTimeoutMs: 0 },
  ])("warns and uses the default for a $category timeout", async ({
    requestTimeoutMs,
  }) => {
    mockLoadRawConfig.mockResolvedValue({ proxy: { requestTimeoutMs } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadRequestTimeoutMs()).toBe(120_000);
    expect(warn).toHaveBeenCalledWith(
      "[proxy] 設定が不正、デフォルト使用:",
      expect.any(String),
    );
    warn.mockRestore();
  });
});
