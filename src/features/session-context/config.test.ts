import { beforeEach, expect, it, vi } from "vitest";
import { loadRawConfig } from "../../config/config.js";
import { loadCompactionConfig } from "./config.js";

vi.mock("../../config/config.js", () => ({ loadRawConfig: vi.fn() }));

beforeEach(() => vi.mocked(loadRawConfig).mockReset());

it.each([
  {},
  { compaction: {} },
])("uses global compaction defaults when omitted (%j)", async (raw) => {
  vi.mocked(loadRawConfig).mockResolvedValue(raw);
  expect(await loadCompactionConfig()).toEqual({
    enabled: true,
    threshold: 0.7,
    keepRecentTokens: 20_000,
  });
});

it("loads global compaction settings and fills omitted fields", async () => {
  vi.mocked(loadRawConfig).mockResolvedValue({
    compaction: { enabled: false, threshold: 0.5, keepRecentTokens: 5000 },
  });
  expect(await loadCompactionConfig()).toEqual({
    enabled: false,
    threshold: 0.5,
    keepRecentTokens: 5000,
  });
  vi.mocked(loadRawConfig).mockResolvedValue({
    compaction: { enabled: false },
  });
  expect(await loadCompactionConfig()).toEqual({
    enabled: false,
    threshold: 0.7,
    keepRecentTokens: 20_000,
  });
});

it.each([
  { threshold: 0 },
  { threshold: 1 },
  { threshold: "0.7" },
  { keepRecentTokens: 0 },
  { keepRecentTokens: 1.5 },
  { enabled: "true" },
])("rejects invalid global compaction settings (%j)", async (compaction) => {
  vi.mocked(loadRawConfig).mockResolvedValue({ compaction });
  await expect(loadCompactionConfig()).rejects.toThrow();
});
