import { afterEach, describe, expect, it, vi } from "vitest";

describe("cron AgentConfig override", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("channel設定を継承し、job指定は同じフィールドだけ完全置換する", async () => {
    vi.resetModules();
    vi.doMock("../agent/model.js", () => ({
      validateModel: vi.fn().mockResolvedValue(undefined),
    }));
    vi.doMock("../config/groups.js", () => ({
      findGroupByName: vi.fn().mockResolvedValue({
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
      }),
    }));

    const { enqueueCronInbox } = await import("./enqueue.js");
    const appendInbox = vi.fn();
    const base = {
      id: "job",
      client: {} as never,
      groupName: "group",
      channelId: "channel",
      deliveryMode: "direct" as const,
      sessionMode: "per-run" as const,
      appendInbox,
    };

    await enqueueCronInbox(base, "channel prompt");
    expect(appendInbox).toHaveBeenLastCalledWith(
      expect.objectContaining({
        configOverride: {
          model: {
            provider: "channel-provider",
            modelId: "channel-model",
          },
          tools: ["read"],
          skills: ["session-logs"],
          mounts: [{ host: "/channel", container: "/channel" }],
        },
      }),
    );

    await enqueueCronInbox(
      {
        ...base,
        model: { provider: "zai", modelId: "glm-4.7-flash" },
        tools: [],
        skills: [],
        mounts: [],
      },
      "job prompt",
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
  });
});
