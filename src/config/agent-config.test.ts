import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, loadRawConfig: vi.fn() };
});

describe("loadAgentTimeoutMs", () => {
  let loadAgentTimeoutMs: () => Promise<number>;
  let DEFAULT_AGENT_TIMEOUT_MS: number;
  let mockLoadRawConfig: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    const configMod = await import("./config.js");
    mockLoadRawConfig = vi.mocked(configMod.loadRawConfig);
    mockLoadRawConfig.mockResolvedValue({});

    ({ loadAgentTimeoutMs, DEFAULT_AGENT_TIMEOUT_MS } = await import(
      "./agent-config.js"
    ));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("デフォルトは 600000（10分）", async () => {
    expect(await loadAgentTimeoutMs()).toBe(DEFAULT_AGENT_TIMEOUT_MS);
  });

  it("設定ファイルの timeoutMs が読み込まれる", async () => {
    mockLoadRawConfig.mockResolvedValue({ agent: { timeoutMs: 300_000 } });
    expect(await loadAgentTimeoutMs()).toBe(300_000);
  });

  it("設定ファイルに agent キーがない場合はデフォルト値を返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ someOtherKey: {} });
    expect(await loadAgentTimeoutMs()).toBe(DEFAULT_AGENT_TIMEOUT_MS);
  });

  it("設定ファイルの timeoutMs が欠落していてもデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ agent: {} });
    expect(await loadAgentTimeoutMs()).toBe(DEFAULT_AGENT_TIMEOUT_MS);
  });

  it("timeoutMs が不正な値（文字列）は warn してデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ agent: { timeoutMs: "300000" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadAgentTimeoutMs()).toBe(DEFAULT_AGENT_TIMEOUT_MS);
    expect(warn).toHaveBeenCalledWith(
      "[agent] 設定が不正、デフォルト使用:",
      expect.any(String),
    );
    warn.mockRestore();
  });

  it("timeoutMs が 0 以下は不正として warn しデフォルトを返す", async () => {
    mockLoadRawConfig.mockResolvedValue({ agent: { timeoutMs: 0 } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await loadAgentTimeoutMs()).toBe(DEFAULT_AGENT_TIMEOUT_MS);
    warn.mockRestore();
  });
});
