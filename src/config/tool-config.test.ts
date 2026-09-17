import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRawConfig } from "./config.js";
import { loadToolTimeoutMs } from "./tool-config.js";

vi.mock("./config.js", async (original) => ({
  ...(await original<typeof import("./config.js")>()),
  loadRawConfig: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

describe("tool.timeoutMs", () => {
  it.each([
    {},
    { tool: {} },
    { proxy: { requestTimeoutMs: 10 }, agent: { timeoutMs: 20 } },
  ])("defaults independently to 120 seconds: %j", async (config) => {
    vi.mocked(loadRawConfig).mockResolvedValue(config);
    expect(await loadToolTimeoutMs()).toBe(120_000);
  });
  it("loads the configured invocation lifetime", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({ tool: { timeoutMs: 45_000 } });
    expect(await loadToolTimeoutMs()).toBe(45_000);
  });
  it.each([
    0,
    -1,
    0.5,
    "120000",
    2_147_483_648,
  ])("rejects invalid timer values: %s", async (timeoutMs) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(loadRawConfig).mockResolvedValue({ tool: { timeoutMs } });
    expect(await loadToolTimeoutMs()).toBe(120_000);
    expect(warn).toHaveBeenCalled();
  });
});
