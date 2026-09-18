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
    const { resolveProviderLockTarget } = await importFresh();

    await expect(resolveProviderLockTarget("zai")).resolves.toEqual({
      resource: "provider:zai",
      concurrency: "serial",
    });
  });

  it("設定済み provider の parallel を返す", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      { provider: "codex-oauth", concurrency: "parallel" },
    ]);
    const { resolveProviderLockTarget } = await importFresh();

    await expect(resolveProviderLockTarget("codex-oauth")).resolves.toEqual({
      resource: "provider:codex-oauth",
      concurrency: "parallel",
    });
  });

  it("resourceを返し、省略時はprovider名へfallbackする", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      {
        provider: "local-vlm",
        resource: "local-gpu",
        concurrency: "serial",
      },
    ]);
    const { resolveProviderLockTarget } = await importFresh();

    await expect(resolveProviderLockTarget("local-vlm")).resolves.toEqual({
      resource: "resource:local-gpu",
      concurrency: "serial",
    });
    await expect(resolveProviderLockTarget("unknown")).resolves.toEqual({
      resource: "provider:unknown",
      concurrency: "serial",
    });
  });

  it("明示resourceと同名providerの暗黙fallbackを別keyにする", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      { provider: "gateway", resource: "local", concurrency: "parallel" },
    ]);
    const { resolveProviderLockTarget } = await importFresh();

    await expect(resolveProviderLockTarget("gateway")).resolves.toEqual({
      resource: "resource:local",
      concurrency: "parallel",
    });
    await expect(resolveProviderLockTarget("local")).resolves.toEqual({
      resource: "provider:local",
      concurrency: "serial",
    });
  });

  it("同一resourceのconcurrency矛盾を拒否する", async () => {
    vi.mocked(loadRawProviders).mockResolvedValue([
      { provider: "local-llm", resource: "gpu", concurrency: "serial" },
      { provider: "local-vlm", resource: "gpu", concurrency: "parallel" },
    ]);
    const { loadProviders } = await importFresh();

    await expect(loadProviders()).rejects.toThrow(/一致しません/);
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
