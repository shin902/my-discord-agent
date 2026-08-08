import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({ loadRawProviders: vi.fn() }));

const { loadRawProviders } = await import("./config.js");

async function importFresh() {
  vi.resetModules();
  return import("./providers.js");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provider concurrency config", () => {
  it("serial / parallel を読み込む", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      { provider: "zai", concurrency: "serial" },
      { provider: "codex-oauth", concurrency: "parallel" },
    ]);
    const { loadProviders } = await importFresh();

    await expect(loadProviders()).resolves.toEqual([
      { provider: "zai", concurrency: "serial" },
      { provider: "codex-oauth", concurrency: "parallel" },
    ]);
  });

  it("同一 import でも毎回最新の concurrency を読み込む", async () => {
    vi.mocked(loadRawProviders)
      .mockResolvedValueOnce([{ provider: "zai", concurrency: "serial" }])
      .mockResolvedValueOnce([{ provider: "zai", concurrency: "parallel" }]);
    const { loadProviders } = await importFresh();

    await expect(loadProviders()).resolves.toEqual([
      { provider: "zai", concurrency: "serial" },
    ]);
    await expect(loadProviders()).resolves.toEqual([
      { provider: "zai", concurrency: "parallel" },
    ]);
    expect(loadRawProviders).toHaveBeenCalledTimes(2);
  });

  it("未設定 provider は安全側の serial にする", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([]);
    const { resolveProviderConcurrency } = await importFresh();

    await expect(resolveProviderConcurrency("zai")).resolves.toBe("serial");
  });

  it("設定済み provider の parallel を返す", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      { provider: "codex-oauth", concurrency: "parallel" },
    ]);
    const { resolveProviderConcurrency } = await importFresh();

    await expect(resolveProviderConcurrency("codex-oauth")).resolves.toBe(
      "parallel",
    );
  });

  it("不正な concurrency を拒否する", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      { provider: "zai", concurrency: "sometimes" },
    ]);
    const { loadProviders } = await importFresh();

    await expect(loadProviders()).rejects.toThrow();
  });

  it("provider の重複を拒否する", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      { provider: "zai", concurrency: "serial" },
      { provider: "zai", concurrency: "parallel" },
    ]);
    const { loadProviders } = await importFresh();

    await expect(loadProviders()).rejects.toThrow(/重複/);
  });
});
