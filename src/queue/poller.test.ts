import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageOptions } from "../agent/manager.js";
import {
  type ArticleDispatch,
  claimUnreadArticles,
  listDispatchClaims,
  listUnreadArticles,
  openRssDb,
  saveFeedEntries,
} from "../rss/store.js";
import { NonRetryableError, TransientError } from "../utils/error.js";
import type { InboxMessage } from "./types.js";

const sendMessage = vi.fn<
  (group: string, session: string, content: string, options?: SendMessageOptions) => Promise<string>
>();
const findGroupByName = vi.fn<typeof import("../config/groups.js").findGroupByName>();
const resolveModelConfig = vi.fn<typeof import("../config/default-model.js").resolveModelConfig>();
const resolveProviderConcurrency = vi.fn<typeof import("../config/providers.js").resolveProviderConcurrency>();
const discordClient = {
  isReady: vi.fn().mockReturnValue(false),
  channels: { cache: { get: vi.fn().mockReturnValue(undefined) }, fetch: vi.fn() },
};
const getDiscordClientForGroupName = vi.fn(async (_group: string) => discordClient);
const getDiscordClients = () => new Map([["personal", discordClient]]);
const client = discordClient;
const claim = vi.fn();
const commitInboxResult = vi.fn();
const deadLetter = vi.fn();
const failAttempt = vi.fn();
const freezeExecutionIdentity = vi.fn();
const heartbeat = vi.fn();
const markRunning = vi.fn();
const updateRunning = vi.fn();
const getJob = vi.fn();
const repository = { claim, commitResult: commitInboxResult, deadLetter, failAttempt, freezeExecutionIdentity, heartbeat, markRunning, updateRunning, get: getJob };
const { processMessage, startPoller, stopPoller } = await import("./poller.js");
const { createPoller } = await import("./poller.js");
createPoller({
  sendMessage,
  findGroupByName,
  resolveModelConfig,
  resolveProviderConcurrency,
  getDiscordClients: getDiscordClients,
  getDiscordClientForGroupName: getDiscordClientForGroupName,
  getQueueRepository: () => repository,
});

let tempDirs: string[] = [];

beforeEach(() => {
  sendMessage.mockClear();
  claim.mockReset();
  claim.mockReturnValue(undefined);
  deadLetter.mockClear();
  heartbeat.mockReset();
  markRunning.mockReset();
  updateRunning.mockClear();
  getJob.mockReset();
  getJob.mockReturnValue(undefined);
  client.isReady.mockReturnValue(false);
  resolveModelConfig.mockImplementation(async (model) => ({
    provider: model?.provider ?? "zai",
    modelId: model?.modelId ?? "glm-4.7-flash",
  }));
  resolveProviderConcurrency.mockResolvedValue("serial");
});

afterEach(async () => {
  stopPoller();
  vi.useRealTimers();
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  tempDirs = [];
});

async function makeRssPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "poller-rss-test-"));
  tempDirs.push(dir);
  return join(dir, "rss.sqlite3");
}

function seedUnreadArticles(path: string, count: number): void {
  const db = openRssDb(path);
  try {
    saveFeedEntries(db, {
      url: "https://example.com/feed.xml",
      parsedName: "Feed",
      etag: null,
      lastModified: null,
      entries: Array.from({ length: count }, (_, index) => ({
        entryId: `article-${index + 1}`,
        title: `Article ${index + 1}`,
        link: `https://example.com/article-${index + 1}`,
        publishedAt: `2026-08-0${index + 1}`,
        summary: `Summary ${index + 1}`,
      })),
      markInitialAsRead: false,
    });
  } finally {
    db.close();
  }
}

function claimRssArticles(
  path: string,
  owner: string,
  limit: number,
): ArticleDispatch {
  const db = openRssDb(path);
  try {
    const dispatch = claimUnreadArticles(db, owner, limit);
    if (!dispatch) throw new Error("expected RSS dispatch");
    return dispatch;
  } finally {
    db.close();
  }
}

function makeMsg(overrides?: Partial<InboxMessage>): InboxMessage {
  const now = new Date().toISOString();
  return {
    id: "inbox-1",
    channelId: "ch-1",
    groupName: "default",
    sessionId: "ch-1",
    messageId: "msg-original",
    content: "hello",
    timestamp: now,
    enqueuedAt: now,
    fencingToken: 4,
    retries: 0,
    ...overrides,
  };
}

describe("processMessage - terminal queue transitions", () => {
  beforeEach(() => {
    findGroupByName.mockResolvedValue({
      name: "default",
      channels: [],
      allowMention: false,
    });
    sendMessage.mockReset();
    client.channels.fetch.mockResolvedValue({
      isSendable: () => false,
      isTextBased: () => false,
    });
    deadLetter.mockClear();
    failAttempt.mockClear();
    markRunning.mockClear();
    updateRunning.mockClear();
    commitInboxResult.mockClear();
    freezeExecutionIdentity.mockClear();
    freezeExecutionIdentity.mockResolvedValue(undefined);
  });

  it("invalid cron jobs are dead-lettered with one fenced transition", async () => {
    const msg = makeMsg({
      cronDeliveryMode: "new-thread",
      cronJobId: undefined,
    });

    await processMessage(msg);

    expect(deadLetter).toHaveBeenCalledOnce();
    expect(deadLetter).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "invalid_cron_job",
    );
  });

  it("non-retryable errors are dead-lettered once with execution metadata", async () => {
    const error = new NonRetryableError("invalid input");
    const executionTiming = {
      termination: "close" as const,
      exitCode: 23,
      preparationMs: 1,
      dockerRunMs: 2,
      assistantTurns: 1,
    };
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        options?.onExecutionTiming?.(
          executionTiming,
        );
        throw error;
      },
    );
    const msg = makeMsg();

    await processMessage(msg);

    expect(deadLetter).toHaveBeenCalledOnce();
    expect(deadLetter).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "non_retryable",
      String(error),
      expect.objectContaining({
        exitCode: 23,
        termination: "close",
        timing: executionTiming,
      }),
    );
  });

  it("retryable errors are delegated to the repository failAttempt, never decided in the poller", async () => {
    const error = new Error("temporary failure");
    sendMessage.mockRejectedValue(error);
    const msg = makeMsg();

    await processMessage(msg);

    expect(failAttempt).toHaveBeenCalledOnce();
    expect(failAttempt).toHaveBeenCalledWith(
      msg.id,
      error,
      msg.fencingToken,
      expect.objectContaining({ metadata: expect.any(Object) }),
    );
    // the poller no longer makes retry-count / max-attempt dead-letter decisions
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it("non-zero exit fails the attempt with execution metadata in an options object", async () => {
    const executionTiming = {
      termination: "close" as const,
      exitCode: 7,
      preparationMs: 1,
      dockerRunMs: 2,
      assistantTurns: 1,
    };
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        options?.onExecutionTiming?.(
          executionTiming,
        );
        return "partial response";
      },
    );
    const msg = makeMsg();

    await processMessage(msg);

    expect(failAttempt).toHaveBeenCalledOnce();
    expect(failAttempt).toHaveBeenCalledWith(
      msg.id,
      expect.any(Error),
      msg.fencingToken,
      {
        metadata: expect.objectContaining({
          exitCode: 7,
          termination: "close",
          timing: executionTiming,
        }),
      },
    );
    expect(commitInboxResult).not.toHaveBeenCalled();
  });

  it("null 終了コードのキャンセルは成功レスポンスにせず再試行へ回す", async () => {
    const executionTiming = {
      termination: "close" as const,
      exitCode: null,
      preparationMs: 1,
      dockerRunMs: 2,
    };
    const error = new TransientError("コンテナがシグナルで終了しました");
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        options?.onExecutionTiming?.(
          executionTiming,
        );
        throw error;
      },
    );
    const msg = makeMsg();

    await processMessage(msg);

    expect(failAttempt).toHaveBeenCalledWith(
      msg.id,
      error,
      msg.fencingToken,
      expect.objectContaining({
        metadata: expect.objectContaining({
          exitCode: null,
          termination: "close",
          timing: executionTiming,
        }),
      }),
    );
    expect(commitInboxResult).not.toHaveBeenCalled();
    expect(deadLetter).not.toHaveBeenCalled();
  });

  it("通常ルートの onContainerStarted は sessionId の conversationPath で running を記録する", async () => {
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        options?.onContainerStarted?.();
        return "AI response";
      },
    );
    const msg = makeMsg();

    await processMessage(msg);

    expect(markRunning).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      expect.objectContaining({
        startedAt: expect.any(String),
        workspacePath: `groups/${msg.groupName}`,
        conversationPath: `data/sessions/${msg.groupName}/${msg.sessionId}.jsonl`,
      }),
    );
  });

  it("cron new-thread の onContainerStarted は導出 sessionId の conversationPath で running を記録する", async () => {
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        options?.onContainerStarted?.();
        return "AI response";
      },
    );
    const msg = makeMsg({
      cronDeliveryMode: "new-thread",
      cronJobId: "daily",
      cronThreadId: "thread-1",
    });

    await processMessage(msg);

    expect(markRunning).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      expect.objectContaining({
        workspacePath: `groups/${msg.groupName}`,
        conversationPath: `data/sessions/${msg.groupName}/thread-1.jsonl`,
      }),
    );
  });

  it("onContainerStarted の同期的な queue 例外は callback の外へ throw せず失敗扱いになる", async () => {
    const error = new Error("mark running failed");
    markRunning.mockImplementation(() => {
      throw error;
    });
    let synchronousError: unknown;
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        const callback = options
          ?.onContainerStarted;
        let result: void | Promise<void>;
        try {
          result = callback?.();
        } catch (callbackError) {
          synchronousError = callbackError;
          return "AI response";
        }
        await result;
        return "AI response";
      },
    );
    const msg = makeMsg();

    await processMessage(msg);

    expect(synchronousError).toBeUndefined();
    expect(failAttempt).toHaveBeenCalledWith(
      msg.id,
      error,
      msg.fencingToken,
      expect.objectContaining({ metadata: expect.any(Object) }),
    );
    expect(commitInboxResult).not.toHaveBeenCalled();
  });

  it("cron new-thread destination persists the created thread before using it as the session", async () => {
    const msg = makeMsg({
      sessionId: "cron-daily-run-placeholder",
      cronDeliveryMode: "new-thread",
      cronSessionMode: "destination",
      cronJobId: "daily",
      timestamp: "2026-06-04T10:30:00.000Z",
    });
    const create = vi.fn(async () => ({ id: "thread-actual" }));
    client.channels.fetch.mockResolvedValueOnce({
      threads: { create },
    });
    updateRunning.mockImplementation((_id, _token, patch) => {
      Object.assign(msg, patch);
    });
    sendMessage.mockImplementation(
      async (_group, session, _content, options: SendMessageOptions | undefined) => {
        expect(session).toBe("thread-actual");
        options?.onContainerStarted?.();
        return "AI response";
      },
    );

    await processMessage(msg);

    expect(create).toHaveBeenCalledWith({
      name: "cron-daily-2026-06-04-19-30",
    });
    expect(updateRunning).toHaveBeenCalledWith(msg.id, msg.fencingToken, {
      cronThreadId: "thread-actual",
      sessionId: "thread-actual",
    });
    expect(sendMessage).toHaveBeenCalledWith(
      "default",
      "thread-actual",
      "hello",
      expect.any(Object),
    );
    expect(commitInboxResult).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "AI response",
      expect.objectContaining({
        deliveryPayload: expect.objectContaining({
          cronThreadId: "thread-actual",
        }),
      }),
    );
  });

  it("cron new-thread per-run はスレッド作成前の仮セッションを維持する", async () => {
    const msg = makeMsg({
      sessionId: "cron-daily-run-placeholder",
      cronDeliveryMode: "new-thread",
      cronSessionMode: "per-run",
      cronJobId: "daily",
    });
    sendMessage.mockImplementation(
      async (_group, session, _content, options: SendMessageOptions | undefined) => {
        expect(session).toBe("cron-daily-run-placeholder");
        options?.onContainerStarted?.();
        return "AI response";
      },
    );

    await processMessage(msg);

    expect(updateRunning).not.toHaveBeenCalled();
    expect(commitInboxResult).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "AI response",
      expect.objectContaining({
        deliveryPayload: expect.objectContaining({
          destinationType: "new-thread",
          cronThreadId: undefined,
        }),
      }),
    );
  });

  it("cron new-thread のリモート作成後の transport failure は再試行せず ambiguous として終了する", async () => {
    const msg = makeMsg({
      sessionId: "cron-daily-run-placeholder",
      cronDeliveryMode: "new-thread",
      cronSessionMode: "destination",
      cronJobId: "daily",
    });
    const create = vi.fn(async () => {
      // Discord may have created the thread before the response was lost.
      throw new TypeError("network timeout after remote create");
    });
    client.channels.fetch.mockResolvedValueOnce({
      threads: { create },
    });

    await processMessage(msg);

    expect(create).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(updateRunning).not.toHaveBeenCalled();
    expect(failAttempt).not.toHaveBeenCalled();
    expect(deadLetter).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "ambiguous_cron_thread",
      expect.stringContaining("network timeout after remote create"),
      expect.any(Object),
    );
  });

  it("fencingToken 未設定の cron new-thread は running を記録しない", async () => {
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        options?.onContainerStarted?.();
        return "AI response";
      },
    );
    const msg = makeMsg({
      cronDeliveryMode: "new-thread",
      cronJobId: "daily",
      fencingToken: undefined,
    });

    await processMessage(msg);

    expect(markRunning).not.toHaveBeenCalled();
  });

  it("cron new-thread の非ゼロ終了コードは failAttempt に記録され commit されない", async () => {
    const executionTiming = {
      termination: "close" as const,
      exitCode: 9,
      preparationMs: 1,
      dockerRunMs: 2,
      assistantTurns: 1,
    };
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        options?.onExecutionTiming?.(
          executionTiming,
        );
        return "partial response";
      },
    );
    const msg = makeMsg({
      cronDeliveryMode: "new-thread",
      cronJobId: "daily",
      cronThreadId: "thread-1",
    });

    await processMessage(msg);

    expect(failAttempt).toHaveBeenCalledOnce();
    expect(failAttempt).toHaveBeenCalledWith(
      msg.id,
      expect.any(Error),
      msg.fencingToken,
      {
        metadata: expect.objectContaining({
          exitCode: 9,
          termination: "close",
          timing: executionTiming,
        }),
      },
    );
    expect(commitInboxResult).not.toHaveBeenCalled();
  });

  it("identity capture failure fails the attempt with error metadata", async () => {
    freezeExecutionIdentity.mockRejectedValueOnce(
      new Error("identity boom"),
    );
    const msg = makeMsg();

    await processMessage(msg);

    expect(failAttempt).toHaveBeenCalledOnce();
    expect(failAttempt).toHaveBeenCalledWith(
      msg.id,
      expect.any(Error),
      msg.fencingToken,
      { metadata: { error: expect.any(Error) } },
    );
  });
});

describe("processMessage - RSS dispatch settlement wiring", () => {
  beforeEach(() => {
    findGroupByName.mockResolvedValue({
      name: "default",
      channels: [],
      allowMention: false,
    });
    sendMessage.mockResolvedValue("AI response");
    commitInboxResult.mockClear();
    failAttempt.mockClear();
    deadLetter.mockClear();
    freezeExecutionIdentity.mockResolvedValue(undefined);
  });

  it("marks only the claimed RSS articles read after successful processing", async () => {
    const rssPath = await makeRssPath();
    seedUnreadArticles(rssPath, 2);
    const dispatch = claimRssArticles(rssPath, "cron-rss", 1);
    const msg = makeMsg({
      id: "rss-success",
      idempotencyKey: dispatch.jobId,
      rssDispatchId: dispatch.id,
      rssStatePath: rssPath,
    });
    getJob.mockReturnValue({
      status: "completed",
      idempotencyKey: dispatch.jobId,
    });

    await processMessage(msg);

    expect(commitInboxResult).toHaveBeenCalledOnce();
    expect(getJob).toHaveBeenCalledWith(msg.id);
    const db = openRssDb(rssPath);
    try {
      expect(
        listUnreadArticles(db, 10).map((article) => article.title),
      ).toEqual(["Article 2"]);
      expect(listDispatchClaims(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("releases the RSS claim after a processing failure", async () => {
    const rssPath = await makeRssPath();
    seedUnreadArticles(rssPath, 1);
    const dispatch = claimRssArticles(rssPath, "cron-rss", 1);
    const error = new Error("temporary failure");
    sendMessage.mockRejectedValue(error);
    const msg = makeMsg({
      id: "rss-retry",
      idempotencyKey: dispatch.jobId,
      rssDispatchId: dispatch.id,
      rssStatePath: rssPath,
    });
    getJob.mockReturnValue({
      status: "retry_wait",
      idempotencyKey: dispatch.jobId,
    });

    await processMessage(msg);

    expect(deadLetter).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "agent_error",
      undefined,
      expect.any(Object),
    );
    const db = openRssDb(rssPath);
    try {
      expect(listUnreadArticles(db, 10)).toHaveLength(1);
      expect(listDispatchClaims(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("RSS directのグループ設定欠損はclaimを解放する", async () => {
    const rssPath = await makeRssPath();
    seedUnreadArticles(rssPath, 1);
    const dispatch = claimRssArticles(rssPath, "cron-rss", 1);
    findGroupByName.mockResolvedValue(undefined);
    const msg = makeMsg({
      id: "rss-config-unavailable",
      cronDeliveryMode: "direct",
      idempotencyKey: dispatch.jobId,
      rssDispatchId: dispatch.id,
      rssStatePath: rssPath,
    });

    await processMessage(msg);

    expect(deadLetter).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "config-unavailable",
      undefined,
      expect.any(Object),
    );
    const db = openRssDb(rssPath);
    try {
      expect(listUnreadArticles(db, 10)).toHaveLength(1);
      expect(listDispatchClaims(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("releases the RSS claim after a terminal dead-letter failure", async () => {
    const rssPath = await makeRssPath();
    seedUnreadArticles(rssPath, 1);
    const dispatch = claimRssArticles(rssPath, "cron-rss", 1);
    const error = new NonRetryableError("invalid input");
    sendMessage.mockRejectedValue(error);
    const msg = makeMsg({
      id: "rss-dead-letter",
      idempotencyKey: dispatch.jobId,
      rssDispatchId: dispatch.id,
      rssStatePath: rssPath,
    });
    getJob.mockReturnValue({
      status: "dead_letter",
      idempotencyKey: dispatch.jobId,
    });

    await processMessage(msg);

    expect(deadLetter).toHaveBeenCalledWith(
      msg.id,
      msg.fencingToken,
      "agent_error",
      undefined,
      expect.any(Object),
    );
    const db = openRssDb(rssPath);
    try {
      expect(listUnreadArticles(db, 10)).toHaveLength(1);
      expect(listDispatchClaims(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("poller lease renewal", () => {
  it("heartbeat の同期的な queue 例外は lease callback の外へ throw せず abort する", async () => {
    vi.useFakeTimers();
    const error = new Error("heartbeat failed");
    heartbeat.mockImplementation(() => {
      throw error;
    });
    commitInboxResult.mockClear();
    findGroupByName.mockResolvedValue({
      name: "default",
      channels: [],
      allowMention: false,
    });
    client.channels.fetch.mockResolvedValue({
      isSendable: () => false,
      isTextBased: () => false,
    });
    const msg = makeMsg({
      agentsSnapshotPresent: false,
      memorySnapshotPresent: false,
      snapshotPresent: false,
      snapshotHash: "snapshot",
      toolCallKey: "tool-call",
    });
    claim.mockReturnValueOnce({ job: msg }).mockReturnValue(undefined);
    client.isReady.mockReturnValue(true);

    let signal: AbortSignal | undefined;
    let releaseAgent!: (response: string) => void;
    const agentResult = new Promise<string>((resolve) => {
      releaseAgent = resolve;
    });
    sendMessage.mockImplementation(
      async (_group, _session, _content, options: SendMessageOptions | undefined) => {
        signal = options?.signal;
        return agentResult;
      },
    );

    startPoller();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendMessage).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(heartbeat).toHaveBeenCalledWith(msg.id, msg.fencingToken, 60_000);
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe(error);

    releaseAgent("AI response");
    await vi.advanceTimersByTimeAsync(0);
    expect(commitInboxResult).toHaveBeenCalledOnce();
  });
});

describe("processMessage - allowMention", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    findGroupByName.mockReset();
    sendMessage.mockResolvedValue("AI response");
    client.channels.fetch.mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    });
    commitInboxResult.mockClear();
    mockSend.mockClear();
  });

  it("allowMention metadata is handled without a final Discord send", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: true,
    });

    await processMessage(makeMsg({ messageId: "msg-original" }));

    expect(mockSend).not.toHaveBeenCalled();
    expect(commitInboxResult).toHaveBeenCalledOnce();
  });

  it("missing messageId does not trigger a final Discord send", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: true,
    });

    await processMessage(makeMsg({ messageId: undefined }));

    expect(mockSend).not.toHaveBeenCalled();
    expect(commitInboxResult).toHaveBeenCalledOnce();
  });

  it("allowMention false does not trigger a final Discord send", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    expect(commitInboxResult).toHaveBeenCalledOnce();
  });

  it("attachments と configOverride を sendMessage に渡す", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });
    const attachments = [
      {
        url: "https://cdn.discordapp.com/attachments/x/y/photo.png",
        name: "photo.png",
        contentType: "image/png",
        size: 12345,
      },
    ];
    const configOverride = { tools: ["read"], skills: ["session-logs"] };

    await processMessage(makeMsg({ attachments, configOverride }));

    expect(sendMessage).toHaveBeenCalledWith(
      "default",
      "ch-1",
      "hello",
      expect.objectContaining({
        onDiscordEvent: expect.any(Function),
        attachments,
        onExecutionTiming: expect.any(Function),
        configOverride,
      }),
    );
  });

  it("応答時間を区間別の構造化ログに記録する", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onExecutionTiming?.({
          termination: "close",
          exitCode: 0,
          preparationMs: 5,
          dockerRunMs: 35,
          imagePullMs: 10,
          containerAndAgentMs: 25,
          promptMs: 20,
          postPromptMs: 1,
          assistantTurns: 1,
          usage: {
            input: 100,
            output: 20,
            cacheRead: 80,
            cacheWrite: 0,
            totalTokens: 120,
          },
          stopReason: "stop",
        });
        return "AI response";
      },
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processMessage(makeMsg());

    const line = logSpy.mock.calls
      .flat()
      .find((value) => String(value).includes('"event":"response_timing"'));
    expect(line).toBeDefined();
    const details = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(details).toMatchObject({
      event: "response_timing",
      outcome: "success",
      preparationMs: 5,
      agentTermination: "close",
      agentExitCode: 0,
      dockerRunMs: 35,
      imagePullMs: 10,
      containerAndAgentMs: 25,
      containerStartupMs: 4,
      promptMs: 20,
      postPromptMs: 1,
      assistantTurns: 1,
      usage: {
        input: 100,
        output: 20,
        cacheRead: 80,
        cacheWrite: 0,
        totalTokens: 120,
      },
      stopReason: "stop",
    });
    expect(details.queueWaitMs).toEqual(expect.any(Number));
    expect(details.llmLockWaitMs).toEqual(expect.any(Number));

    logSpy.mockRestore();
  });

  it("空応答は success ではなく empty-response として記録する", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });
    sendMessage.mockResolvedValue("");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    const line = logSpy.mock.calls
      .flat()
      .find((value) => String(value).includes('"event":"response_timing"'));
    const details = JSON.parse(String(line).slice(String(line).indexOf("{")));
    expect(details.outcome).toBe("empty-response");
    logSpy.mockRestore();
  });

  it("送信不能チャンネルでも agent 結果は Discord 送信なしで完了する", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });
    client.channels.fetch.mockResolvedValue({
      isSendable: () => false,
      isTextBased: () => false,
    });

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    expect(commitInboxResult).toHaveBeenCalledOnce();
  });

  it("複数チャンクも agent 結果として一度だけ確定する", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: true,
    });
    sendMessage.mockResolvedValue("A".repeat(2001));

    await processMessage(makeMsg());

    expect(mockSend).not.toHaveBeenCalled();
    expect(commitInboxResult).toHaveBeenCalledOnce();
  });
});

describe("processMessage - Discord イベント通知", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });
    client.channels.fetch.mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    });
    mockSend.mockClear();
  });

  it("tool_start イベント（args あり）で 🔧 ツール名 + 引数が送信される", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: true,
    });
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "tool_start",
          toolName: "read_file",
          args: { path: "/workspace/foo.ts" },
        });
        return "AI response";
      },
    );

    await processMessage(makeMsg({ messageId: "msg-original" }));

    await vi.waitFor(() => {
      // allowMention が true でもツールコールはリプライしない
      expect(mockSend).toHaveBeenCalledWith(
        expect.stringMatching(/^🔧 `read_file` /),
      );
      const call = mockSend.mock.calls.find((c) =>
        String(c[0]).startsWith("🔧"),
      );
      expect(call).toBeDefined();
    });
  });

  it("tool_start イベント（args なし）で 🔧 ツール名のみが送信される", async () => {
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "tool_start",
          toolName: "bash",
        });
        return "AI response";
      },
    );

    await processMessage(makeMsg());

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        content: "🔧 `bash`",
        allowedMentions: { parse: [], repliedUser: false },
      });
    });
  });

  it("cronJobId が設定されている（direct cron）場合、tool_start イベントは送信されない", async () => {
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "tool_start",
          toolName: "bash",
        });
        return "AI response";
      },
    );

    await processMessage(makeMsg({ cronJobId: "daily-report" }));

    expect(mockSend).not.toHaveBeenCalled();
  });

  it("cronJobId が設定されていても error イベントは送信される", async () => {
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "error",
          message: "oops",
        });
        return "";
      },
    );

    await processMessage(makeMsg({ cronJobId: "daily-report" }));

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        content: "⚠️ エラー: oops",
        reply: { messageReference: "msg-original", failIfNotExists: false },
        allowedMentions: { parse: [], repliedUser: false },
      });
    });
  });

  it("error イベントで ⚠️ メッセージが Discord に送信される", async () => {
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "error",
          message: "Context window exceeded",
        });
        return "";
      },
    );

    await processMessage(makeMsg());

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        content: "⚠️ エラー: Context window exceeded",
        reply: { messageReference: "msg-original", failIfNotExists: false },
        allowedMentions: { parse: [], repliedUser: false },
      });
    });
  });

  it("allowMention: true のとき error イベントは元メッセージに reply 形式で送信される", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: true,
    });
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "error",
          message: "Context window exceeded",
        });
        return "";
      },
    );

    await processMessage(makeMsg({ messageId: "msg-original" }));

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        content: "⚠️ エラー: Context window exceeded",
        reply: { messageReference: "msg-original", failIfNotExists: false },
        allowedMentions: { repliedUser: true },
      });
    });
  });

  it("allowMention: false のとき error イベントは返信するが通知しない", async () => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "error",
          message: "oops",
        });
        return "";
      },
    );

    await processMessage(makeMsg({ messageId: "msg-original" }));

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledWith({
        content: "⚠️ エラー: oops",
        reply: { messageReference: "msg-original", failIfNotExists: false },
        allowedMentions: { parse: [], repliedUser: false },
      });
    });
  });

  it("2000文字を超えるイベントテキストは先頭2000文字に切り詰められる", async () => {
    const longMessage = "x".repeat(2100);
    sendMessage.mockImplementation(
      async (_g, _s, _c, options: SendMessageOptions | undefined) => {
        options?.onDiscordEvent?.({
          type: "error",
          message: longMessage,
        });
        return "";
      },
    );

    await processMessage(makeMsg());

    await vi.waitFor(() => {
      expect(mockSend).toHaveBeenCalledOnce();
      const sent = mockSend.mock.calls[0][0];
      expect(sent).toEqual(expect.objectContaining({ content: expect.any(String) }));
      expect(sent.content.length).toBeLessThanOrEqual(2000);
      expect(sent.content.endsWith("…")).toBe(true);
    });
  });
});
describe("processMessage - durable result", () => {
  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockResolvedValue("AI response");
    commitInboxResult.mockClear();
    commitInboxResult.mockClear();
    client.channels.fetch.mockClear();
  });

  it("commits the agent result and queues delivery metadata without Discord sends", async () => {
    findGroupByName.mockResolvedValue({
      name: "default",
      channels: [],
      allowMention: true,
    });
    const msg = makeMsg({ fencingToken: 4, messageId: "msg-original" });

    await processMessage(msg);

    expect(commitInboxResult).toHaveBeenCalledWith(
      msg.id,
      4,
      "AI response",
      expect.objectContaining({
        empty: false,
        deliveryPayload: {
          groupName: "default",
          destinationType: "channel",
          destinationId: "ch-1",
          replyMessageId: "msg-original",
          allowMention: true,
        },
      }),
    );
  });
  it("keeps typing progress independent from final result delivery", async () => {
    const sendTyping = vi.fn().mockResolvedValue(undefined);
    client.channels.cache.get.mockReturnValue({
      isTextBased: () => true,
      sendTyping,
    });
    findGroupByName.mockResolvedValue({
      name: "default",
      channels: [],
    });
    const msg = makeMsg();

    await processMessage(msg);

    expect(sendTyping).toHaveBeenCalled();
    expect(commitInboxResult).toHaveBeenCalledOnce();
  });

  it("RSS cron new-threadの空応答はclaimを解放しdelivery/threadを作らない", async () => {
    const rssPath = await makeRssPath();
    seedUnreadArticles(rssPath, 1);
    const dispatch = claimRssArticles(rssPath, "cron-rss", 1);
    sendMessage.mockResolvedValue("");
    const msg = makeMsg({
      id: "rss-empty-new-thread",
      cronJobId: "cron-rss",
      cronDeliveryMode: "new-thread",
      cronSessionMode: "per-run",
      idempotencyKey: dispatch.jobId,
      rssDispatchId: dispatch.id,
      rssStatePath: rssPath,
    });

    await processMessage(msg);

    expect(commitInboxResult).not.toHaveBeenCalled();
    expect(deadLetter).toHaveBeenCalled();
    const db = openRssDb(rssPath);
    try {
      expect(listDispatchClaims(db)).toEqual([]);
      expect(listUnreadArticles(db, 10)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("does not create a delivery for an empty agent result", async () => {
    findGroupByName.mockResolvedValue({
      name: "default",
      channels: [],
    });
    sendMessage.mockResolvedValue("");
    const msg = makeMsg({ fencingToken: 4 });

    await processMessage(msg);

    expect(commitInboxResult).toHaveBeenCalledWith(
      msg.id,
      4,
      "",
      expect.objectContaining({ empty: true }),
    );
  });
});

describe("processMessage - provider ごとの LLM ロック", () => {
  const mockSend = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    findGroupByName.mockResolvedValue({
      name: "g",
      channels: [],
      allowMention: false,
    });
    client.channels.fetch.mockResolvedValue({
      isSendable: () => true,
      isTextBased: () => false,
      send: mockSend,
    });
    mockSend.mockClear();
  });

  it("同じデフォルト serial provider は sendMessage の実行が重複しない", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveFirst!: (value: string) => void;
    const first = new Promise<string>((r) => {
      resolveFirst = r;
    });

    sendMessage.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const result = inFlight === 1 ? await first : "second";
      inFlight--;
      return result;
    });

    const p1 = processMessage(makeMsg({ sessionId: "s1" }));
    const p2 = processMessage(makeMsg({ sessionId: "s2" }));

    await new Promise((r) => setTimeout(r, 20));
    // 1つ目が解決するまで2つ目の sendMessage は開始されない
    expect(maxInFlight).toBe(1);

    resolveFirst("first");
    await Promise.all([p1, p2]);
    expect(maxInFlight).toBe(1);
  });

  it("parallel provider は同じ provider でも並列に sendMessage を実行する", async () => {
    resolveProviderConcurrency.mockResolvedValue("parallel");
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseBoth!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    sendMessage.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await blocker;
      inFlight--;
      return "response";
    });

    const model = { provider: "codex-oauth", modelId: "gpt-5.2-codex" };
    const p1 = processMessage(
      makeMsg({ id: "first", sessionId: "s1", configOverride: { model } }),
    );
    const p2 = processMessage(
      makeMsg({ id: "second", sessionId: "s2", configOverride: { model } }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxInFlight).toBe(2);

    releaseBoth();
    await Promise.all([p1, p2]);
  });

  it("異なる serial provider は並列に sendMessage を実行する", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseBoth!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    sendMessage.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await blocker;
      inFlight--;
      return "response";
    });

    const p1 = processMessage(
      makeMsg({
        id: "provider-a-message",
        sessionId: "s1",
        configOverride: {
          model: { provider: "provider-a", modelId: "model-a" },
        },
      }),
    );
    const p2 = processMessage(
      makeMsg({
        id: "provider-b-message",
        sessionId: "s2",
        configOverride: {
          model: { provider: "provider-b", modelId: "model-b" },
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxInFlight).toBe(2);

    releaseBoth();
    await Promise.all([p1, p2]);
  });

  it("同じ serial provider は異なる session でも直列化する", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let invocation = 0;
    sendMessage.mockImplementation(async () => {
      invocation++;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (invocation === 1) await first;
      inFlight--;
      return "response";
    });

    const model = { provider: "provider-a", modelId: "model-a" };
    const p1 = processMessage(
      makeMsg({ id: "first", sessionId: "s1", configOverride: { model } }),
    );
    const p2 = processMessage(
      makeMsg({ id: "second", sessionId: "s2", configOverride: { model } }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(maxInFlight).toBe(1);

    resolveFirst();
    await Promise.all([p1, p2]);
    expect(maxInFlight).toBe(1);
  });
});
