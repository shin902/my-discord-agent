import { afterEach, describe, expect, it, vi } from "vitest";

describe("@startup validation", () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("handler付き@startup jobを拒否する", async () => {
    vi.doMock("../config/config.js", () => ({
      loadRawCron: vi.fn().mockResolvedValue([
        {
          id: "startup-handler",
          schedule: "@startup",
          handler: "__fixtures__/test-handler.ts",
        },
      ]),
      loadRawGroups: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock("../discord/client.js", () => ({
      getDefaultDiscordClient: vi.fn(),
      getDiscordClientForGroupName: vi.fn(),
      getDiscordClients: vi.fn().mockReturnValue(new Map()),
    }));
    vi.doMock("../queue/repository.js", () => ({
      getQueueRepository: vi.fn().mockReturnValue({ enqueue: vi.fn() }),
    }));

    const { loadAndValidateCron } = await import("./runner.js");

    await expect(loadAndValidateCron()).rejects.toThrow(
      "@startup は handler をサポートしません。prompt jobとして設定してください",
    );
  });
});
