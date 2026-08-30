import { beforeEach, describe, expect, it, vi } from "vitest";

const loadRawConfigFresh = vi.hoisted(() => vi.fn());
vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return { ...actual, loadRawConfigFresh };
});

const { loadAgentMemoryConfig } = await import("./agent-memory.js");

describe("Agent Memory config reload", () => {
  beforeEach(() => loadRawConfigFresh.mockReset());

  it("reads the config from disk for execution-time privacy checks", async () => {
    loadRawConfigFresh.mockResolvedValue({
      agentMemory: {
        enabled: true,
        eligibleGroups: ["new-private-group"],
      },
    });

    await expect(loadAgentMemoryConfig()).resolves.toMatchObject({
      enabled: true,
      eligibleGroups: ["new-private-group"],
    });
    expect(loadRawConfigFresh).toHaveBeenCalledOnce();
  });
});
