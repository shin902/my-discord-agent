import { ChannelType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  repository: undefined as unknown,
  client: {
    isReady: vi.fn().mockReturnValue(true),
    channels: { fetch: vi.fn() },
  },
}));

vi.mock("../agent/manager.js", () => ({
  sendMessage: vi.fn(),
}));
vi.mock("../config/default-model.js", () => ({
  resolveModelConfig: vi.fn().mockResolvedValue({
    provider: "zai",
    modelId: "glm-4.7-flash",
  }),
}));
vi.mock("../config/groups.js", () => ({
  findGroupByName: vi.fn().mockResolvedValue({
    name: "group",
    channels: [],
    allowMention: false,
  }),
}));
vi.mock("../config/providers.js", () => ({
  resolveProviderConcurrency: vi.fn().mockResolvedValue("serial"),
}));
vi.mock("../discord/client.js", () => ({
  getDiscordClientForGroupName: vi.fn().mockResolvedValue(state.client),
  getDiscordClients: () => new Map([["group", state.client]]),
}));
vi.mock("./repository.js", async () => {
  const actual =
    await vi.importActual<typeof import("./repository.js")>("./repository.js");
  return {
    ...actual,
    getQueueRepository: () => state.repository,
  };
});

const { sendMessage } = await import("../agent/manager.js");
const { openRuntimeDb, QueueRepository } = await import("./repository.js");
const { processMessage } = await import("./poller.js");

describe("declarative item-thread poller integration", () => {
  beforeEach(() => {
    state.repository = new QueueRepository(openRuntimeDb(":memory:"));
    state.client.channels.fetch.mockReset();
    vi.mocked(sendMessage).mockReset();
  });

  afterEach(() => {
    (state.repository as InstanceType<typeof QueueRepository>).close();
    state.repository = undefined;
  });

  it("persists an empty item-thread response as terminal failure without delivery", async () => {
    const repository = state.repository as InstanceType<typeof QueueRepository>;
    const item = repository.enqueue({
      channelId: "parent-channel",
      groupName: "group",
      sessionId: "cron-item-placeholder",
      content: "summarize this item",
      timestamp: new Date().toISOString(),
      cronDeliveryMode: "item-thread",
      cronSessionMode: "destination",
      cronThread: true,
      cronJobId: "item-empty-job",
      cronProvisioning: true,
    }).job;
    const claimed = repository.claim("poller");
    if (!claimed) throw new Error("expected item-thread claim");

    const startThread = vi.fn().mockResolvedValue({ id: "thread-empty" });
    const placeholder = { id: "placeholder-empty", startThread };
    const parent = {
      type: ChannelType.GuildText,
      send: vi.fn().mockResolvedValue(placeholder),
    };
    const edit = vi.fn().mockResolvedValue(undefined);
    const failureChannel = {
      messages: {
        fetch: vi.fn().mockResolvedValue({ edit }),
      },
    };
    state.client.channels.fetch
      .mockResolvedValueOnce(parent)
      .mockResolvedValueOnce(failureChannel);
    vi.mocked(sendMessage).mockResolvedValue(" \r\n\t");

    await processMessage(claimed.job);

    expect(repository.get(item.id)).toMatchObject({
      status: "dead_letter",
      terminalReason: "empty_response",
      terminalState: "empty_response",
      cronPlaceholderMessageId: "placeholder-empty",
      cronThreadId: "thread-empty",
      sessionId: "thread-empty",
    });
    expect(repository.getDelivery(item.id)).toBeUndefined();
    expect(repository.listDeliveries()).toHaveLength(0);
    expect(
      repository.db
        .prepare("SELECT reason,error,source FROM dead_letters WHERE job_id=?")
        .get(item.id),
    ).toMatchObject({
      reason: "empty_response",
      error: null,
      source: "queue",
    });
    expect(edit).toHaveBeenCalledWith("⚠️ 処理に失敗しました");
  });

  it("provisions Discord IDs and authoritative session before sendMessage", async () => {
    const repository = state.repository as InstanceType<typeof QueueRepository>;
    const item = repository.enqueue({
      channelId: "parent-channel",
      groupName: "group",
      sessionId: "cron-item-placeholder",
      content: "summarize this item",
      timestamp: new Date().toISOString(),
      cronDeliveryMode: "item-thread",
      cronSessionMode: "destination",
      cronThread: true,
      cronJobId: "item-job",
      cronProvisioning: true,
    }).job;
    const claimed = repository.claim("poller");
    if (!claimed) throw new Error("expected item-thread claim");

    const startThread = vi.fn().mockResolvedValue({ id: "thread-1" });
    const placeholder = { id: "placeholder-1", startThread };
    const parent = {
      type: ChannelType.GuildText,
      send: vi.fn().mockResolvedValue(placeholder),
    };
    state.client.channels.fetch.mockResolvedValueOnce(parent);

    vi.mocked(sendMessage).mockImplementation(async (_group, sessionId) => {
      const persisted = repository.get(item.id);
      expect(persisted).toMatchObject({
        cronPlaceholderMessageId: "placeholder-1",
        cronThreadId: "thread-1",
        sessionId: "thread-1",
        cronProvisioning: false,
      });
      expect(sessionId).toBe("thread-1");
      return "item response";
    });

    await processMessage(claimed.job);

    expect(parent.send).toHaveBeenCalledWith("処理中…");
    expect(startThread).toHaveBeenCalledOnce();
    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      "group",
      "thread-1",
      "summarize this item",
      expect.any(Object),
    );
    expect(repository.get(item.id)).toMatchObject({
      status: "completed",
      cronPlaceholderMessageId: "placeholder-1",
      cronThreadId: "thread-1",
      sessionId: "thread-1",
      cronProvisioning: false,
    });
    expect(repository.getDelivery(item.id)?.payloadJson).toContain(
      '"cronPlaceholderMessageId":"placeholder-1"',
    );
  });
});
