import { beforeEach, describe, expect, it, vi } from "vitest";

const loadRawConfig = vi.hoisted(() => vi.fn());
vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, loadRawConfig };
});

const { loadAgentMemoryConfig } = await import("./agent-memory.js");

describe("Agent Memory config lifetime", () => {
  beforeEach(() => loadRawConfig.mockReset());

  it("uses the cached process config rather than re-reading from disk", async () => {
    loadRawConfig.mockResolvedValue({
      agentMemory: {
        enabled: true,
        eligibleGroups: ["new-private-group"],
      },
    });

    await expect(loadAgentMemoryConfig()).resolves.toMatchObject({
      enabled: true,
      eligibleGroups: ["new-private-group"],
    });
    expect(loadRawConfig).toHaveBeenCalledOnce();
  });
});
