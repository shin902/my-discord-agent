import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRawConfig } from "../../config/config.js";
import { loadAgentMemoryThreshold } from "./config.js";

vi.mock("../../config/config.js", async (original) => ({
  ...(await original<typeof import("../../config/config.js")>()),
  loadRawConfig: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

describe("agentMemory threshold", () => {
  it.each([
    {},
    { agentMemory: {} },
  ])("defaults to provisional 0.7 for %j", async (raw) => {
    vi.mocked(loadRawConfig).mockResolvedValue(raw);
    expect(await loadAgentMemoryThreshold()).toBe(0.7);
  });
  it.each([0, 0.8, 1])("accepts %s", async (threshold) => {
    vi.mocked(loadRawConfig).mockResolvedValue({ agentMemory: { threshold } });
    expect(await loadAgentMemoryThreshold()).toBe(threshold);
  });
  it.each([
    -0.1,
    1.1,
    "0.8",
    null,
  ])("warns and uses default for %s", async (threshold) => {
    vi.mocked(loadRawConfig).mockResolvedValue({ agentMemory: { threshold } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await loadAgentMemoryThreshold()).toBe(0.7);
    expect(warn).toHaveBeenCalledOnce();
  });
});
