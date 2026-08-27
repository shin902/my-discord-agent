import { afterEach, describe, expect, it, vi } from "vitest";

describe("cron AgentConfig override", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    "channel",
    "thread",
  ])("配送先が%sでもchannel設定を継承せず、job指定だけを完全置換する", async (destinationId) => {
    vi.resetModules();
    vi.doMock("../agent/model.js", () => ({
      validateModel: vi.fn().mockResolvedValue(undefined),
    }));
    const findGroupByName = vi.fn().mockResolvedValue({
      name: "group",
      channels: [
        {
          channelId: "channel",
          sessionMode: "shared",
          model: {
            provider: "channel-provider",
            modelId: "channel-model",
          },
          tools: ["read"],
          skills: ["session-logs"],
          mounts: [{ host: "/channel", container: "/channel" }],
        },
      ],
    });
    vi.doMock("../config/groups.js", () => ({ findGroupByName }));

    const { enqueueCronInbox } = await import("./enqueue.js");
    const appendInbox = vi.fn();
    const base = {
      id: "job",
      client: {} as never,
      groupName: "group",
      channelId: destinationId,
      deliveryMode: "direct" as const,
      sessionMode: "per-run" as const,
      appendInbox,
    };

    await enqueueCronInbox(base, `${destinationId} prompt`);
    expect(appendInbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channelId: destinationId,
        groupName: "group",
      }),
    );
    expect(appendInbox.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "configOverride",
    );

    await enqueueCronInbox(
      {
        ...base,
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: [],
        skills: [],
        mounts: [],
      },
      `${destinationId} job prompt`,
    );
    expect(appendInbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configOverride: {
          model: { provider: "zai", modelId: "glm-4.7-flash" },
          tools: [],
          skills: [],
          mounts: [],
        },
      }),
    );
    expect(findGroupByName).not.toHaveBeenCalled();
  });
});
