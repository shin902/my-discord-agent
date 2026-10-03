import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { SendMessageOptions } from "../agent/manager.js";
import { expectDefined } from "../test-utils.js";

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
  resolveProviderLockTarget: vi.fn().mockResolvedValue({
    provider: "provider-a",
    resource: "provider-a",
    concurrency: "serial",
  }),
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

// Keep session files outside manager.test.ts's shared-directory cleanup.
const sessions = await mkdtemp(join(tmpdir(), "poller-item-sessions-"));
vi.stubEnv("SESSIONS_DIR", sessions);
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(sessions, { recursive: true, force: true });
});

const { sendMessage } = await import("../agent/manager.js");
const { appendMessage, loadMessages } = await import("../agent/session.js");
const { openRuntimeDb, QueueRepository } = await import("./repository.js");
const { processMessage } = await import("./poller.js");
const { registerRssSource } = await import("../features/rss.js");
const { SourceHandlers } = await import("./source-handlers.js");
const { JobHandlers } = await import("./job-handlers.js");

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

  it.each([
    ["new-thread", "final-only"],
    ["item-thread", "final-only"],
    ["new-thread", "destination"],
    ["item-thread", "destination"],
  ] as const)("passes the selected history to a %s/%s retry without changing raw entries", async (deliveryMode, sessionMode) => {
    const repository = state.repository as InstanceType<typeof QueueRepository>;
    const initialSessionId = `${deliveryMode}-${sessionMode}-temporary`;
    const sessionId =
      deliveryMode === "new-thread"
        ? `${deliveryMode}-${sessionMode}-thread`
        : initialSessionId;
    const final = {
      role: "assistant",
      content: [{ type: "text", text: "previous public final" }],
      stopReason: "stop",
      timestamp: 1,
    } as AgentMessage;
    const userEntryId = await appendMessage(
      "group",
      sessionId,
      {
        role: "user",
        content: "previous input",
        timestamp: 1,
      },
      "main",
    );
    const assistantEntryId = await appendMessage(
      "group",
      sessionId,
      final,
      "main",
    );
    repository.enqueue({
      groupName: "group",
      channelId: "parent-channel",
      sessionId,
      content: "previous input",
      timestamp: new Date().toISOString(),
    });
    const prior = expectDefined(repository.claim("seed"));
    repository.commitResult(
      prior.job.id,
      prior.fencingToken,
      "previous public final",
      {
        conversation: { userEntryId, assistantEntryId },
      },
    );

    const create = vi.fn().mockResolvedValue({ id: sessionId });
    state.client.channels.fetch.mockResolvedValue({ threads: { create } });
    const item = repository.enqueue({
      channelId: "parent-channel",
      groupName: "group",
      sessionId: initialSessionId,
      content: "current input",
      timestamp: new Date().toISOString(),
      cronDeliveryMode: deliveryMode,
      cronSessionMode: sessionMode,
      cronJobId: "history-retry",
      ...(deliveryMode === "item-thread" ? { cronProvisioning: true } : {}),
    }).job;
    vi.mocked(sendMessage).mockImplementationOnce(
      async (group, target, _content, options) => {
        await options.onContainerStarted?.();
        await appendMessage(
          group,
          target,
          {
            role: "user",
            content: "failed attempt input",
            timestamp: 2,
          },
          "main",
        );
        await appendMessage(
          group,
          target,
          {
            role: "assistant",
            content: [{ type: "text", text: "failed attempt progress" }],
            stopReason: "stop",
            timestamp: 2,
          } as AgentMessage,
          "main",
        );
        await appendMessage(
          group,
          target,
          {
            role: "toolResult",
            toolCallId: "call",
            toolName: "read",
            content: [{ type: "text", text: "failed attempt tool trace" }],
            isError: false,
            timestamp: 2,
          },
          "main",
        );
        throw new Error("injected attempt failure");
      },
    );
    const first = expectDefined(repository.claim("poller"));
    await processMessage(first.job);
    const retrying = expectDefined(repository.get(item.id));
    expect(retrying.status).toBe("retry_wait");
    const rawBeforeRetry = await loadMessages("group", sessionId, "main");
    expect(rawBeforeRetry).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
      }),
    );
    expect([...repository.readCommittedConversations("group")]).toEqual([
      { userEntryId, assistantEntryId },
    ]);

    vi.mocked(sendMessage).mockImplementationOnce(
      async (_group, _target, _content, options) => {
        await options.onContainerStarted?.();
        return "retry final";
      },
    );
    const second = expectDefined(
      repository.claim(
        "poller",
        60_000,
        new Date(expectDefined(retrying.nextAttemptAt)),
      ),
    );
    await processMessage(second.job);
    expect(repository.get(item.id)?.status).toBe("completed");
    expect(sendMessage).toHaveBeenLastCalledWith(
      "group",
      sessionId,
      "current input",
      expect.objectContaining({ agentId: "main" }),
    );
    const options = vi.mocked(sendMessage).mock
      .calls[1][3] as SendMessageOptions;
    expect(options.historyMessages).toEqual(
      sessionMode === "final-only" ? [final] : undefined,
    );
    expect(await loadMessages("group", sessionId, "main")).toEqual(
      rawBeforeRetry,
    );
    if (deliveryMode === "new-thread") {
      expect(create).toHaveBeenCalledOnce();
      expect(second.job.cronThreadId).toBe(sessionId);
    } else {
      expect(create).not.toHaveBeenCalled();
    }
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
    const sources = new SourceHandlers();
    registerRssSource(sources, repository);
    repository.registerSources(sources);
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
      idempotencyKey: "rss-dispatch-job",
      feature: {
        kind: "rss",
        input: {
          dispatchId: "rss-dispatch-id",
          statePath: "data/rss.sqlite3",
          dispatchJobId: "rss-dispatch-job",
        },
      },
    }).job;
    const claimed = repository.claim("poller");
    if (!claimed) throw new Error("expected item-thread claim");

    vi.mocked(sendMessage).mockResolvedValue("item response");

    await processMessage(claimed.job, undefined, new JobHandlers(), sources);

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
    expect(JSON.parse(delivery?.payloadJson ?? "{}")).toMatchObject({
      feature: {
        kind: "rss",
        input: {
          dispatchId: "rss-dispatch-id",
          statePath: "data/rss.sqlite3",
          dispatchJobId: "rss-dispatch-job",
        },
      },
    });
    expect(state.client.channels.fetch).not.toHaveBeenCalled();
  });
});
