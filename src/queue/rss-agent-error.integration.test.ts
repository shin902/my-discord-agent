import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageOptions } from "../agent/manager.js";
import {
  claimUnreadArticles,
  listDispatchClaims,
  listUnreadArticles,
  openRssDb,
  saveFeedEntries,
} from "../rss/store.js";
import type { InboxMessage } from "./types.js";

const mocks = vi.hoisted(() => {
  const AgentMock = vi.fn();
  const client = {
    isReady: vi.fn().mockReturnValue(false),
    channels: {
      cache: { get: vi.fn().mockReturnValue(undefined) },
      fetch: vi.fn().mockResolvedValue({ isTextBased: () => false }),
    },
  };
  return {
    AgentMock,
    appendMessage: vi.fn(),
    client,
    currentRepository: undefined as unknown,
    findGroupByName: vi.fn(),
    getDiscordClientForGroupName: vi.fn().mockResolvedValue(client),
    loadMessages: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    resolveModel: vi.fn(),
    resolveModelConfig: vi.fn(),
    resolveProviderConcurrency: vi.fn(),
    sendMessage: vi.fn(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: mocks.readFile,
  readdir: mocks.readdir,
}));
vi.mock("@earendil-works/pi-agent-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@earendil-works/pi-agent-core")>()),
  Agent: mocks.AgentMock,
}));
vi.mock("../agent/manager.js", () => ({
  sendMessage: mocks.sendMessage,
  validateAgentConfiguration: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../agent/model.js", () => ({ resolveModel: mocks.resolveModel }));
vi.mock("../agent/session.js", () => ({
  appendMessage: mocks.appendMessage,
  loadMessages: mocks.loadMessages,
}));
vi.mock("../config/credential-proxy.js", () => ({
  loadCredentialProxy: vi.fn().mockResolvedValue([]),
}));
vi.mock("../config/default-model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/default-model.js")>()),
  resolveModelConfig: mocks.resolveModelConfig,
}));
vi.mock("../config/groups.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/groups.js")>()),
  findGroupByName: mocks.findGroupByName,
}));
vi.mock("../config/providers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/providers.js")>()),
  resolveProviderConcurrency: mocks.resolveProviderConcurrency,
}));
vi.mock("../discord/client.js", () => ({
  getDiscordClientForGroupName: mocks.getDiscordClientForGroupName,
  getDiscordClients: () => new Map([["default", mocks.client]]),
}));
vi.mock("./repository.js", () => ({
  getQueueRepository: () => mocks.currentRepository,
}));

const repositoryModule =
  await vi.importActual<typeof import("./repository.js")>("./repository.js");
const { runAgentLoop } = await import("../sandbox/agent-runner.js");
const { processMessage } = await import("./poller.js");

const tempDirs: string[] = [];
let queueRepository:
  | InstanceType<typeof repositoryModule.QueueRepository>
  | undefined;

function seedUnreadArticle(path: string): void {
  const db = openRssDb(path);
  try {
    saveFeedEntries(db, {
      url: "https://example.com/feed.xml",
      parsedName: "Feed",
      etag: null,
      lastModified: null,
      entries: [
        {
          entryId: "article-1",
          title: "Article",
          link: "https://example.com/article",
          publishedAt: "2026-08-01",
          summary: "Summary",
        },
      ],
      markInitialAsRead: false,
    });
  } finally {
    db.close();
  }
}

function makeMessage(
  dispatchJobId: string,
  dispatchId: string,
  rssPath: string,
): Omit<InboxMessage, "id" | "retries" | "enqueuedAt"> {
  return {
    channelId: "channel",
    groupName: "default",
    sessionId: "rss-session",
    messageId: "message",
    content: "summarize",
    timestamp: new Date().toISOString(),
    idempotencyKey: dispatchJobId,
    rssDispatchId: dispatchId,
    rssStatePath: rssPath,
  };
}

beforeEach(() => {
  const subscribers: Array<(event: unknown) => void> = [];
  mocks.AgentMock.mockReset().mockImplementation(function () {
    return {
      subscribe: vi.fn((callback: (event: unknown) => void) => {
        subscribers.push(callback);
      }),
      prompt: vi.fn(async () => {
        for (const callback of subscribers) {
          callback({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "部分的な応答" }],
              errorMessage: "upstream response failed",
            },
          });
        }
      }),
    };
  });
  mocks.appendMessage.mockReset().mockResolvedValue(undefined);
  mocks.findGroupByName.mockReset().mockResolvedValue({
    name: "default",
    channels: [],
    allowMention: false,
  });
  mocks.loadMessages.mockReset().mockResolvedValue([]);
  mocks.readFile
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  mocks.readdir
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  mocks.resolveModel.mockReset().mockResolvedValue({
    id: "model",
    provider: "zai",
  });
  mocks.resolveModelConfig.mockReset().mockResolvedValue({
    provider: "zai",
    modelId: "model",
  });
  mocks.resolveProviderConcurrency.mockReset().mockResolvedValue("serial");
  mocks.sendMessage
    .mockReset()
    .mockImplementation(
      async (
        _group: string,
        session: string,
        content: string,
        options?: SendMessageOptions,
      ) => {
        await options?.onContainerStarted?.();
        try {
          return await runAgentLoop("default", session, content, {});
        } finally {
          options?.onExecutionTiming?.({
            termination: "close",
            exitCode: 2,
            preparationMs: 1,
            dockerRunMs: 2,
          });
        }
      },
    );
  mocks.currentRepository = undefined;
});

afterEach(async () => {
  try {
    queueRepository?.close();
  } catch {
    // The test may have already closed the repository before reopening it.
  }
  queueRepository = undefined;
  mocks.currentRepository = undefined;
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("RSS runner to poller assistant error", () => {
  it("durably releases an RSS claim after the manager reports a failed exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rss-runner-poller-test-"));
    tempDirs.push(dir);
    const rssPath = join(dir, "rss.sqlite3");
    const runtimePath = join(dir, "runtime.sqlite");
    seedUnreadArticle(rssPath);
    const rssDb = openRssDb(rssPath);
    const dispatch = claimUnreadArticles(rssDb, "cron-rss", 1);
    if (!dispatch) throw new Error("expected RSS dispatch");
    rssDb.close();

    queueRepository = new repositoryModule.QueueRepository(
      repositoryModule.openRuntimeDb(runtimePath),
      "rss-agent-test",
    );
    mocks.currentRepository = queueRepository;
    const queued = queueRepository.enqueue(
      makeMessage(dispatch.jobId, dispatch.id, rssPath),
      { idempotencyKey: dispatch.jobId },
    );
    const claimed = queueRepository.claim("rss-agent-test", 60_000);
    if (!claimed) throw new Error("expected queue claim");
    const commitResultSpy = vi.spyOn(queueRepository, "commitResult");

    await processMessage(claimed.job);

    expect(mocks.appendMessage).toHaveBeenCalledWith(
      "default",
      "rss-session",
      expect.objectContaining({
        errorMessage: "upstream response failed",
      }),
    );
    expect(commitResultSpy).not.toHaveBeenCalled();
    commitResultSpy.mockRestore();

    queueRepository.close();
    queueRepository = new repositoryModule.QueueRepository(
      runtimePath,
      "rss-agent-verifier",
    );
    mocks.currentRepository = queueRepository;
    expect(queueRepository.get(queued.job.id)).toMatchObject({
      status: "dead_letter",
      terminalState: "non_retryable",
      exitCode: 2,
      termination: "close",
      succeeded: false,
    });
    expect(queueRepository.get(queued.job.id)?.resultJson).toBeUndefined();
    expect(
      queueRepository.db
        .prepare("SELECT reason FROM dead_letters WHERE job_id=?")
        .get(queued.job.id),
    ).toEqual({ reason: "rss_agent_error" });

    const check = openRssDb(rssPath);
    try {
      expect(listUnreadArticles(check, 10)).toHaveLength(1);
      expect(listDispatchClaims(check)).toEqual([]);
      expect(claimUnreadArticles(check, "next-cron", 1)?.articles).toHaveLength(
        1,
      );
    } finally {
      check.close();
    }
  });
});
