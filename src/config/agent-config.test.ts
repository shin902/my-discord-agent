import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, loadRawConfig: vi.fn() };
});

describe("loadAgentTimeoutMs", () => {
  let loadAgentTimeoutMs: () => Promise<number>;
  let mockLoadRawConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const configMod = await import("./config.js");
    mockLoadRawConfig = vi.mocked(configMod.loadRawConfig);

    ({ loadAgentTimeoutMs } = await import("./agent-config.js"));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    {},
    { someOtherKey: {} },
    { agent: {} },
  ])("timeoutMs 未指定なら600000（10分）を返す: %j", async (config) => {
    mockLoadRawConfig.mockResolvedValue(config);
    expect(await loadAgentTimeoutMs()).toBe(600_000);
  });

  it("設定ファイルの timeoutMs が読み込まれる", async () => {
    mockLoadRawConfig.mockResolvedValue({ agent: { timeoutMs: 300_000 } });
    expect(await loadAgentTimeoutMs()).toBe(300_000);
  });

  it("timeoutMs が不正な値（文字列）は warn してデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ agent: { timeoutMs: "300000" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadAgentTimeoutMs()).toBe(600_000);
    expect(warn).toHaveBeenCalledWith(
      "[agent] 設定が不正、デフォルト使用:",
      expect.any(String),
    );
    warn.mockRestore();
  });

  it("timeoutMs が 0 以下は不正として warn しデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ agent: { timeoutMs: 0 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadAgentTimeoutMs()).toBe(600_000);
    warn.mockRestore();
  });
});
