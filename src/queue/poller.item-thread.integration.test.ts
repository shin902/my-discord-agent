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
vi.mock("../config/groups.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/groups.js")>();
  return {
    ...actual,
    findGroupByName: vi.fn().mockResolvedValue({
      name: "group",
      channels: [],
      allowMention: false,
    }),
  };
});
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

  it("persists an empty item-thread response as terminal failure without Discord mutation", async () => {
    const repository = state.repository as InstanceType<typeof QueueRepository>;
    const item = repository.enqueue({
      channelId: "parent-channel",
      groupName: "group",
      sessionId: "cron-item-temporary",
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

    vi.mocked(sendMessage).mockResolvedValue(" \r\n\t");

    await processMessage(claimed.job);

    expect(repository.get(item.id)).toMatchObject({
      status: "dead_letter",
      terminalReason: "empty_response",
      terminalState: "empty_response",
      sessionId: "cron-item-temporary",
      cronProvisioning: true,
    });
    expect(
      repository
        .listDeliveries()
        .find((delivery) => delivery.jobId === item.id),
    ).toBeUndefined();
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
    expect(state.client.channels.fetch).not.toHaveBeenCalled();
  });

  it("runs the agent in the temporary session and defers Discord materialization to delivery", async () => {
    const repository = state.repository as InstanceType<typeof QueueRepository>;
    const item = repository.enqueue({
      channelId: "parent-channel",
      groupName: "group",
      sessionId: "cron-item-temporary",
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

    vi.mocked(sendMessage).mockResolvedValue("item response");

    await processMessage(claimed.job);

    expect(vi.mocked(sendMessage)).toHaveBeenCalledWith(
      "group",
      "cron-item-temporary",
      "summarize this item",
      expect.any(Object),
    );
    expect(repository.get(item.id)).toMatchObject({
      status: "completed",
      sessionId: "cron-item-temporary",
      cronProvisioning: true,
    });
    const delivery = repository
      .listDeliveries()
      .find((delivery) => delivery.jobId === item.id);
    expect(delivery).toBeDefined();
    expect(delivery?.destinationType).toBe("item-thread");
    expect(delivery?.cronThreadId).toBeUndefined();
    expect(delivery?.payloadJson).not.toContain("cronPlaceholderMessageId");
    expect(state.client.channels.fetch).not.toHaveBeenCalled();
  });
});
