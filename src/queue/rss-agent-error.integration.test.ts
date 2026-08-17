import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    claim: vi.fn(),
    client,
    commitResult: vi.fn(),
    deadLetter: vi.fn(),
    failAttempt: vi.fn(),
    findGroupByName: vi.fn(),
    freezeExecutionIdentity: vi.fn(),
    getJob: vi.fn(),
    getDiscordClientForGroupName: vi.fn().mockResolvedValue(client),
    heartbeat: vi.fn(),
    loadMessages: vi.fn(),
    markRunning: vi.fn(),
    readFile: vi.fn(),
    readdir: vi.fn(),
    resolveModel: vi.fn(),
    resolveModelConfig: vi.fn(),
    resolveProviderConcurrency: vi.fn(),
    sendMessage: vi.fn(),
    updateRunning: vi.fn(),
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
  getQueueRepository: () => ({
    claim: mocks.claim,
    commitResult: mocks.commitResult,
    deadLetter: mocks.deadLetter,
    failAttempt: mocks.failAttempt,
    freezeExecutionIdentity: mocks.freezeExecutionIdentity,
    get: mocks.getJob,
    heartbeat: mocks.heartbeat,
    markRunning: mocks.markRunning,
    updateRunning: mocks.updateRunning,
  }),
}));

const { runAgentLoop } = await import("../sandbox/agent-runner.js");
const { processMessage } = await import("./poller.js");

const tempDirs: string[] = [];

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
): InboxMessage {
  const now = new Date().toISOString();
  return {
    id: "rss-runner-error",
    channelId: "channel",
    groupName: "default",
    sessionId: "rss-session",
    messageId: "message",
    content: "summarize",
    timestamp: now,
    enqueuedAt: now,
    fencingToken: 1,
    retries: 0,
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
  mocks.claim.mockReset().mockReturnValue(undefined);
  mocks.commitResult.mockReset();
  mocks.deadLetter.mockReset();
  mocks.failAttempt.mockReset();
  mocks.findGroupByName.mockReset().mockResolvedValue({
    name: "default",
    channels: [],
    allowMention: false,
  });
  mocks.freezeExecutionIdentity.mockReset().mockResolvedValue(undefined);
  mocks.getJob.mockReset().mockReturnValue({
    status: "dead_letter",
    idempotencyKey: "rss-job",
  });
  mocks.heartbeat.mockReset();
  mocks.loadMessages.mockReset().mockResolvedValue([]);
  mocks.markRunning.mockReset();
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
      async (_group: string, session: string, content: string) =>
        runAgentLoop("default", session, content, {}),
    );
  mocks.updateRunning.mockReset();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("RSS runner to poller assistant error", () => {
  it("keeps a partial assistant error unread and lets the next cron claim it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rss-runner-poller-test-"));
    tempDirs.push(dir);
    const rssPath = join(dir, "rss.sqlite3");
    seedUnreadArticle(rssPath);
    const db = openRssDb(rssPath);
    const dispatch = claimUnreadArticles(db, "cron-rss", 1);
    if (!dispatch) throw new Error("expected RSS dispatch");
    db.close();

    const message = makeMessage(dispatch.jobId, dispatch.id, rssPath);
    mocks.getJob.mockReturnValue({
      status: "dead_letter",
      idempotencyKey: dispatch.jobId,
    });

    await processMessage(message);

    expect(mocks.appendMessage).toHaveBeenCalledWith(
      "default",
      "rss-session",
      expect.objectContaining({
        errorMessage: "upstream response failed",
      }),
    );
    expect(mocks.deadLetter).toHaveBeenCalledWith(
      message.id,
      message.fencingToken,
      "rss_agent_error",
      expect.stringContaining("upstream response failed"),
      expect.any(Object),
    );
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
