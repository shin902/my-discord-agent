import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentExecutionTiming,
  type DiscordEvent,
  sendMessage,
} from "../agent/manager.js";
import { resolveModelConfig } from "../config/default-model.js";
import { findGroupByName, type ModelConfig } from "../config/groups.js";
import {
  type ProviderConcurrency,
  resolveProviderConcurrency,
} from "../config/providers.js";
import {
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";
import { NonRetryableError } from "../utils/error.js";
import { classifyDiscordError, DeliveryError } from "./delivery.js";
import { acquireLlmLock } from "./llm-mutex.js";
import { settleRssDispatch } from "./reconciliation.js";
import { type ExecutionMetadata, getQueueRepository } from "./repository.js";
import type { InboxMessage } from "./types.js";

const POLL_MS = 1000;
const SLOW_RESPONSE_MS = 60_000;
let running = false;

type ResponseOutcome =
  | "success"
  | "empty-response"
  | "retry"
  | "dead-letter"
  | "unexpected-error";

interface ResponseTiming {
  startedAt: number;
  receivedAt?: number;
  enqueuedAt?: number;
  queueWaitMs: number;
  lockWaitMs?: number;
  agentTotalMs?: number;
  agentExecution?: AgentExecutionTiming;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function startResponseTiming(msg: InboxMessage): ResponseTiming {
  const startedAt = Date.now();
  const receivedAt = parseTimestamp(msg.timestamp);
  const enqueuedAt = parseTimestamp(msg.enqueuedAt);
  return {
    startedAt,
    receivedAt,
    enqueuedAt,
    queueWaitMs: Math.max(
      0,
      startedAt - (enqueuedAt ?? receivedAt ?? startedAt),
    ),
  };
}
function executionMetadata(timing: ResponseTiming): ExecutionMetadata {
  const execution = timing.agentExecution;
  return execution
    ? {
        exitCode: execution.exitCode,
        termination: execution.termination,
        stopReason: execution.stopReason,
        usage: execution.usage,
        timing: execution,
        agentsSnapshotHash: execution.agentsSnapshotHash,
        memorySnapshotHash: execution.memorySnapshotHash,
        snapshotHash: execution.snapshotHash,
        toolCallKey: execution.toolCallKey,
      }
    : {};
}

function logResponseTiming(
  msg: InboxMessage,
  timing: ResponseTiming,
  outcome: ResponseOutcome,
): void {
  const finishedAt = Date.now();
  const ingressMs =
    timing.receivedAt !== undefined && timing.enqueuedAt !== undefined
      ? Math.max(0, timing.enqueuedAt - timing.receivedAt)
      : undefined;
  const processingMs = Math.max(0, finishedAt - timing.startedAt);
  const totalMs =
    timing.receivedAt !== undefined
      ? Math.max(0, finishedAt - timing.receivedAt)
      : processingMs;
  const containerStartupMs =
    timing.agentExecution?.containerAndAgentMs !== undefined &&
    timing.agentExecution.promptMs !== undefined
      ? Math.max(
          0,
          timing.agentExecution.containerAndAgentMs -
            timing.agentExecution.promptMs -
            (timing.agentExecution.postPromptMs ?? 0),
        )
      : undefined;
  const stages = [
    ["ingress", ingressMs],
    ["queue", timing.queueWaitMs],
    ["llm-lock", timing.lockWaitMs],
    ["preparation", timing.agentExecution?.preparationMs],
    ["image-pull", timing.agentExecution?.imagePullMs],
    [
      containerStartupMs !== undefined ? "container-startup" : "docker-agent",
      containerStartupMs ??
        timing.agentExecution?.containerAndAgentMs ??
        timing.agentExecution?.dockerRunMs ??
        timing.agentTotalMs,
    ],
    ["agent-prompt", timing.agentExecution?.promptMs],
    ["post-prompt", timing.agentExecution?.postPromptMs],
  ] as const;
  const slowestStage = stages.reduce<{ name: string; ms: number } | undefined>(
    (slowest, [name, ms]) =>
      ms !== undefined && (slowest === undefined || ms > slowest.ms)
        ? { name, ms }
        : slowest,
    undefined,
  );
  const details = {
    event: "response_timing",
    inboxId: msg.id,
    discordMessageId: msg.messageId,
    groupName: msg.groupName,
    sessionId: msg.sessionId,
    retries: msg.retries,
    outcome,
    ingressMs,
    queueWaitMs: timing.queueWaitMs,
    llmLockWaitMs: timing.lockWaitMs,
    agentTotalMs: timing.agentTotalMs,
    preparationMs: timing.agentExecution?.preparationMs,
    agentTermination: timing.agentExecution?.termination,
    agentExitCode: timing.agentExecution?.exitCode,
    dockerRunMs: timing.agentExecution?.dockerRunMs,
    imagePullMs: timing.agentExecution?.imagePullMs,
    containerAndAgentMs: timing.agentExecution?.containerAndAgentMs,
    containerStartupMs,
    promptMs: timing.agentExecution?.promptMs,
    postPromptMs: timing.agentExecution?.postPromptMs,
    assistantTurns: timing.agentExecution?.assistantTurns,
    usage: timing.agentExecution?.usage,
    stopReason: timing.agentExecution?.stopReason,
    processingMs,
    totalMs,
    slowestStage: slowestStage?.name,
  };
  const message = JSON.stringify(details);
  if (totalMs >= SLOW_RESPONSE_MS) {
    console.warn(`[poller] 応答遅延を検出: ${message}`);
  } else {
    console.log(`[poller] 応答時間: ${message}`);
  }
}

function settleRssDispatchAfterQueueTransition(msg: InboxMessage): void {
  if (!msg.rssDispatchId) return;
  try {
    const job = getQueueRepository().get(msg.id);
    if (!job) return;
    const resolution =
      job.status === "completed"
        ? "completed"
        : job.status === "dead_letter"
          ? "dead_letter"
          : undefined;
    if (!resolution) return;
    settleRssDispatch(
      msg.rssStatePath,
      msg.rssDispatchId,
      job.idempotencyKey ?? msg.idempotencyKey,
      resolution,
    );
  } catch (error) {
    // Queue terminal state is already durable; startup reconciliation can
    // retry this cross-database update if the RSS store is unavailable.
    console.error(
      `[poller] RSS dispatch状態の収束に失敗しました (${msg.id}):`,
      error,
    );
  }
}

// Durable claims provide session ordering; this set only prevents duplicate in-process dispatch.
const inFlightIds = new Set<string>();

export function startPoller(): void {
  if (running) return;
  running = true;
  void poll();
}

export function stopPoller(): void {
  running = false;
  inFlightIds.clear();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const LEASE_MS = 60_000;
const LEASE_RENEWAL_MS = 20_000;

function discordReady(): boolean {
  return [...getDiscordClients().values()].some((value) => value.isReady());
}

function resolveDiscordClient(groupName: string) {
  return getDiscordClientForGroupName(groupName);
}

function dispatchClaimedMessage(msg: InboxMessage): void {
  const controller = new AbortController();
  const renewal = setInterval(() => {
    void Promise.resolve()
      .then(() =>
        getQueueRepository().heartbeat(msg.id, msg.fencingToken ?? 0, LEASE_MS),
      )
      .catch((error) => {
        console.error(`[poller] lease更新に失敗しました (${msg.id}):`, error);
        controller.abort(error);
      });
  }, LEASE_RENEWAL_MS);
  renewal.unref?.();
  inFlightIds.add(msg.id);
  void processMessage(msg, controller.signal)
    .finally(() => {
      clearInterval(renewal);
      inFlightIds.delete(msg.id);
    })
    .catch((error) =>
      console.error(
        "[poller] 予期せぬエラー (sessionId:",
        msg.sessionId,
        "):",
        error,
      ),
    );
}

const TYPING_INTERVAL_MS = 8_000;

function startTypingLoop(groupName: string, channelId: string): () => void {
  let cancelled = false;
  let cancelSleep: (() => void) | null = null;

  const loop = async () => {
    const client = await resolveDiscordClient(groupName);
    const channel =
      client.channels.cache.get(channelId) ??
      (await client.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) return;

    while (!cancelled) {
      try {
        // PartialGroupDMChannel は sendTyping を持たないため型アサションを使用
        await (channel as { sendTyping(): Promise<void> }).sendTyping();
      } catch {
        // typing indicator はベストエフォート
      }
      // sendTyping() の await 中に stopTyping() が呼ばれた場合はここで抜ける
      if (cancelled) break;
      await new Promise<void>((resolve) => {
        const id = setTimeout(resolve, TYPING_INTERVAL_MS);
        // stopTyping() が clearTimeout してすぐに resolve することでハンドルを即解放する
        cancelSleep = () => {
          clearTimeout(id);
          resolve();
        };
      });
      cancelSleep = null;
    }
  };

  void loop();
  return () => {
    cancelled = true;
    cancelSleep?.();
  };
}

async function sendDiscordEvent(
  groupName: string,
  channelId: string,
  event: DiscordEvent,
  replyMessageId?: string,
  allowMention = false,
): Promise<void> {
  try {
    const client = await resolveDiscordClient(groupName);
    const channel =
      client.channels.cache.get(channelId) ??
      (await client.channels.fetch(channelId).catch(() => null));
    if (!channel?.isSendable()) return;

    let text: string;
    if (event.type === "tool_start") {
      if (event.args !== undefined) {
        const argsStr = JSON.stringify(event.args);
        const truncated =
          argsStr.length > 300 ? `${argsStr.slice(0, 300)}…` : argsStr;
        text = `🔧 \`${event.toolName}\` ${truncated}`;
      } else {
        text = `🔧 \`${event.toolName}\``;
      }
    } else {
      text = `⚠️ エラー: ${event.message}`;
    }

    const DISCORD_MAX = 2000;
    const content =
      text.length > DISCORD_MAX ? `${text.slice(0, DISCORD_MAX - 1)}…` : text;

    const shouldReply = event.type === "error" && replyMessageId;
    const allowedMentions = allowMention
      ? { repliedUser: true }
      : { parse: [], repliedUser: false };
    await channel.send(
      shouldReply
        ? {
            content,
            reply: {
              messageReference: replyMessageId,
              failIfNotExists: false,
            },
            allowedMentions,
          }
        : allowMention
          ? content
          : { content, allowedMentions },
    );
  } catch (err) {
    console.error("[poller] Discord イベント送信エラー:", err);
  }
}

// LLM ロックを取得してから fn() を実行し、完了後に必ず解放する
interface LlmLockOptions {
  onAcquired?: (waitMs: number) => void;
  signal?: AbortSignal;
}

interface LlmLockTarget {
  provider: string;
  concurrency: ProviderConcurrency;
}

async function resolveLlmLockTarget(
  msg: InboxMessage,
  groupModel?: ModelConfig,
): Promise<LlmLockTarget> {
  const model = await resolveModelConfig(
    msg.configOverride?.model ?? groupModel,
  );
  return {
    provider: model.provider,
    concurrency: await resolveProviderConcurrency(model.provider),
  };
}

async function withLlmLock<T>(
  target: LlmLockTarget,
  fn: () => Promise<T>,
  options: LlmLockOptions = {},
): Promise<T> {
  const waitStartedAt = Date.now();
  const release = await acquireLlmLock(
    target.provider,
    target.concurrency,
    options.signal,
  );
  try {
    options.onAcquired?.(Date.now() - waitStartedAt);
    return await fn();
  } finally {
    release();
  }
}

// 非ゼロ終了コードの扱いは通常メッセージと cron new-thread で同一のため共通化する。
// リトライ方針の決定は QueueRepository が所有するため、poller は記録するだけ。
async function failAttemptIfNonZeroExitCode(
  msg: InboxMessage,
  response: string,
  timing: ResponseTiming,
): Promise<boolean> {
  const exitCode = timing.agentExecution?.exitCode;
  if (exitCode === undefined || exitCode === null || exitCode === 0) {
    return false;
  }
  await getQueueRepository().failAttempt(
    msg.id,
    new Error(response || `agent exited with code ${exitCode}`),
    msg.fencingToken,
    { metadata: executionMetadata(timing) },
  );
  return true;
}

// RSS の既読化は有効な LLM 応答が得られた場合だけ許可する。
// 空応答は commitResult せず、記事を既読にしない。既に cron thread を
// 作成済みの実行は claim を保持したままキューで再試行し、空スレッドを残して
// 次回 cron が同じ記事から別スレッドを作ることを防ぐ。それ以外は今回の claim
// だけを解放し、記事を次回 cron が改めて拾えるようにする。
async function failAttemptIfEmptyRssResponse(
  msg: InboxMessage,
  response: string,
  timing: ResponseTiming,
): Promise<boolean> {
  if (!msg.rssDispatchId || response.trim()) return false;
  if (msg.fencingToken === undefined) {
    throw new Error(`RSS empty response requires fencing token: ${msg.id}`);
  }
  if (msg.cronThreadId) {
    await getQueueRepository().failAttempt(
      msg.id,
      new Error("LLM returned an empty response for RSS dispatch"),
      msg.fencingToken,
      { metadata: executionMetadata(timing) },
    );
    return true;
  }
  await getQueueRepository().deadLetter(
    msg.id,
    msg.fencingToken,
    "empty_response",
    "LLM returned an empty response for RSS dispatch",
    executionMetadata(timing),
  );
  return true;
}

// コンテナ起動を running 状態として記録する onContainerStarted ハンドラを生成する。
// 通常メッセージ（sessionId=msg.sessionId）と cron new-thread（導出 sessionId）で同一。
function markRunningWhenContainerStarted(
  msg: InboxMessage,
  sessionId: string,
): () => Promise<void> {
  // The manager consumes this callback through a promise chain. Returning an
  // async function keeps synchronous repository failures in that chain instead
  // of letting an event-emitter callback throw into the host process.
  return async () => {
    if (msg.fencingToken !== undefined) {
      getQueueRepository().markRunning(msg.id, msg.fencingToken, {
        startedAt: new Date().toISOString(),
        workspacePath: `groups/${msg.groupName}`,
        conversationPath: `data/sessions/${msg.groupName}/${sessionId}.jsonl`,
      });
    }
  };
}

function usesCronDestinationSession(msg: InboxMessage): boolean {
  // Legacy cronThread payloads predate the explicit sessionMode and always
  // used the created thread as their conversation identity.
  return (
    msg.cronSessionMode === "destination" ||
    (msg.cronSessionMode === undefined &&
      (msg.cronThread === true || msg.cronDeliveryMode === "new-thread"))
  );
}

function cronSessionId(msg: InboxMessage): string {
  return usesCronDestinationSession(msg)
    ? (msg.cronThreadId ?? msg.sessionId)
    : msg.sessionId;
}

type CronThreadParent = {
  threads?: {
    create: (options: { name: string }) => Promise<{ id?: unknown }>;
  };
};

function discordStatusCode(error: unknown): number | undefined {
  const value = error as { status?: unknown; statusCode?: unknown };
  const code = value?.status ?? value?.statusCode;
  return typeof code === "number" ? code : undefined;
}

async function createCronThread(msg: InboxMessage): Promise<string> {
  let mutationAttempted = false;
  try {
    const client = await resolveDiscordClient(msg.groupName);
    const channel = (await client.channels.fetch(
      msg.channelId,
    )) as unknown as CronThreadParent | null;
    if (!channel) {
      throw new NonRetryableError(
        `cron-thread: チャンネル ${msg.channelId} が見つかりません`,
      );
    }
    if (typeof channel.threads?.create !== "function") {
      throw new NonRetryableError(
        `cron-thread: チャンネル ${msg.channelId} はスレッドをサポートしていません`,
      );
    }
    const dateSuffix = new Date(msg.timestamp)
      .toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" })
      .slice(0, 16)
      .replace(" ", "-")
      .replace(":", "-");
    const suffix = `-${dateSuffix}`;
    const maxIdLength = 100 - "cron-".length - suffix.length;
    const jobId = String(msg.cronJobId ?? msg.id).slice(0, maxIdLength);
    mutationAttempted = true;
    const thread = await channel.threads.create({
      name: `cron-${jobId}${suffix}`,
    });
    const threadId = String(thread.id ?? "");
    if (!threadId) {
      throw new NonRetryableError("cron-thread: Discord thread ID が空です");
    }
    return threadId;
  } catch (error) {
    if (error instanceof NonRetryableError) throw error;
    if (error instanceof DeliveryError) throw error;
    const kind = classifyDiscordError(error);
    // Match the delivery adapter: once Discord was asked to mutate state,
    // transport/unknown failures are ambiguous and must never be retried.
    const postMutationTransportFailure =
      mutationAttempted &&
      discordStatusCode(error) === undefined &&
      (kind === "retryable" || kind === "unknown");
    const effectiveKind = postMutationTransportFailure
      ? "unknown"
      : kind === "unknown"
        ? "retryable"
        : kind;
    throw new DeliveryError(
      effectiveKind,
      error instanceof Error ? error.message : String(error),
      error,
    );
  }
}

async function ensureCronThread(msg: InboxMessage): Promise<void> {
  if (msg.cronThreadId || msg.fencingToken === undefined) return;
  const threadId = await createCronThread(msg);
  try {
    // The thread is an external mutation. Persist its ID before the agent can
    // run so the destination session and the later delivery both use the same
    // durable identity. A claimed job is eligible for updateRunning here.
    getQueueRepository().updateRunning(msg.id, msg.fencingToken, {
      cronThreadId: threadId,
      sessionId: threadId,
    });
  } catch (_error) {
    // Do not blindly create another thread if a local persistence call reports
    // an error after its write may have committed.
    const persisted = getQueueRepository().get(msg.id)?.cronThreadId;
    if (persisted !== threadId) {
      throw new NonRetryableError(
        `cron-thread: スレッドID ${threadId} の永続化に失敗しました`,
      );
    }
  }
  msg.cronThreadId = threadId;
  msg.sessionId = threadId;
}

async function processCronNewThread(
  msg: InboxMessage,
  signal?: AbortSignal,
): Promise<void> {
  const timing = startResponseTiming(msg);
  let outcome: ResponseOutcome = "unexpected-error";
  let sessionId = cronSessionId(msg);
  try {
    if (!msg.cronJobId) {
      outcome = "dead-letter";
      if (msg.fencingToken !== undefined) {
        await getQueueRepository().deadLetter(
          msg.id,
          msg.fencingToken,
          "invalid_cron_job",
        );
      }
      return;
    }
    if (usesCronDestinationSession(msg)) {
      await ensureCronThread(msg);
      sessionId = cronSessionId(msg);
    }
    const groupConfig = await findGroupByName(msg.groupName);
    const lockTarget = await resolveLlmLockTarget(msg, groupConfig?.model);
    const response = await withLlmLock(
      lockTarget,
      async () => {
        const agentStartedAt = Date.now();
        try {
          return await sendMessage(msg.groupName, sessionId, msg.content, {
            onExecutionTiming: (executionTiming) => {
              timing.agentExecution = executionTiming;
            },
            onContainerStarted: markRunningWhenContainerStarted(msg, sessionId),
            signal,
            configOverride: msg.configOverride,
            agentsSnapshotContent: msg.agentsSnapshotContent,
            agentsSnapshotPresent: msg.agentsSnapshotPresent,
            memorySnapshotPresent: msg.memorySnapshotPresent,
            memorySnapshotContent: msg.memorySnapshotContent,
            snapshotHash: msg.snapshotHash,
            toolCallKey: msg.toolCallKey,
          });
        } finally {
          timing.agentTotalMs = Date.now() - agentStartedAt;
        }
      },
      {
        onAcquired: (waitMs) => {
          timing.lockWaitMs = waitMs;
        },
        signal,
      },
    );
    if (await failAttemptIfNonZeroExitCode(msg, response, timing)) return;
    if (await failAttemptIfEmptyRssResponse(msg, response, timing)) return;
    if (msg.fencingToken !== undefined)
      await getQueueRepository().commitResult(
        msg.id,
        msg.fencingToken,
        response,
        {
          empty: !response,
          metadata: executionMetadata(timing),
          deliveryPayload: {
            groupName: msg.groupName,
            destinationType: "new-thread",
            destinationId: msg.channelId,
            cronJobId: msg.cronJobId,
            cronThreadId: msg.cronThreadId,
          },
        },
      );
    outcome = response ? "success" : "empty-response";
  } catch (error) {
    const ambiguousMutation =
      error instanceof DeliveryError && error.kind === "unknown";
    const nonRetryable =
      error instanceof NonRetryableError ||
      (error instanceof DeliveryError && error.kind === "non-retryable");
    if (ambiguousMutation || nonRetryable) {
      outcome = "dead-letter";
      if (nonRetryable) {
        await sendDiscordEvent(
          msg.groupName,
          msg.channelId,
          { type: "error", message: String(error) },
          msg.messageId,
        );
      }
      if (msg.fencingToken !== undefined)
        await getQueueRepository().deadLetter(
          msg.id,
          msg.fencingToken,
          ambiguousMutation ? "ambiguous_cron_thread" : "non_retryable",
          String(error),
          executionMetadata(timing),
        );
    } else {
      outcome = "retry";
      if (msg.fencingToken !== undefined)
        await getQueueRepository().failAttempt(
          msg.id,
          error,
          msg.fencingToken,
          { metadata: executionMetadata(timing) },
        );
    }
  } finally {
    logResponseTiming({ ...msg, sessionId }, timing, outcome);
  }
}
async function captureFrozenIdentity(msg: InboxMessage): Promise<{
  agentsSnapshotContent?: string;
  memorySnapshotContent?: string;
  agentsSnapshotPresent: boolean;
  memorySnapshotPresent: boolean;
  snapshotPresent: boolean;
  snapshotHash: string;
  toolCallKey: string;
}> {
  const base = path.resolve("groups", msg.groupName);
  const readOptional = async (file: string) =>
    readFile(file, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  let agentsSnapshotContent = await readOptional(path.join(base, "AGENTS.md"));
  let memorySnapshotContent = await readOptional(
    path.join(base, "memory", "MEMORY.md"),
  );
  const sessionRaw = await readOptional(
    path.resolve("data", "sessions", msg.groupName, `${msg.sessionId}.jsonl`),
  );
  if (sessionRaw) {
    for (const line of sessionRaw.split(/\r?\n/)) {
      try {
        const entry = JSON.parse(line) as {
          customType?: string;
          content?: unknown;
        };
        if (entry.customType === "agents-snapshot")
          agentsSnapshotContent = String(entry.content ?? "");
        if (entry.customType === "memory-bootstrap")
          memorySnapshotContent = String(entry.content ?? "");
      } catch {
        /* ignore malformed historical lines */
      }
    }
  }
  const agentsSnapshotPresent = agentsSnapshotContent !== undefined;
  const memorySnapshotPresent = memorySnapshotContent !== undefined;
  const snapshotPresent = agentsSnapshotPresent || memorySnapshotPresent;
  const canonicalMemory =
    memorySnapshotContent === undefined
      ? ""
      : memorySnapshotContent.startsWith("## Memory (MEMORY.md)\n\n")
        ? memorySnapshotContent
        : `## Memory (MEMORY.md)\n\n${Array.from(memorySnapshotContent).slice(0, 2000).join("")}${Array.from(memorySnapshotContent).length > 2000 ? "\n\n[Warning: Memory (MEMORY.md) exceeds the limit (2000 characters). Delete or summarize old content to keep it organized]" : ""}`;
  const snapshotHash = createHash("sha256")
    .update(
      `${agentsSnapshotPresent ? "1" : "0"}:${agentsSnapshotContent ?? ""}:${memorySnapshotPresent ? "1" : "0"}:${canonicalMemory}`,
    )
    .digest("hex");
  const toolCallKey = createHash("sha256")
    .update(`${msg.id}:${msg.groupName}:${msg.sessionId}:${snapshotHash}`)
    .digest("hex");
  return {
    agentsSnapshotContent,
    memorySnapshotContent,
    agentsSnapshotPresent,
    memorySnapshotPresent,
    snapshotPresent,
    snapshotHash,
    toolCallKey,
  };
}
export async function processMessage(
  msg: InboxMessage,
  signal?: AbortSignal,
): Promise<void> {
  if (msg.fencingToken !== undefined) {
    try {
      const identity =
        msg.snapshotHash &&
        msg.toolCallKey &&
        msg.agentsSnapshotPresent !== undefined
          ? {
              agentsSnapshotContent: msg.agentsSnapshotContent,
              memorySnapshotContent: msg.memorySnapshotContent,
              agentsSnapshotPresent: msg.agentsSnapshotPresent,
              memorySnapshotPresent: msg.memorySnapshotPresent ?? false,
              snapshotPresent: msg.snapshotPresent ?? false,
              snapshotHash: msg.snapshotHash,
              toolCallKey: msg.toolCallKey,
            }
          : await captureFrozenIdentity(msg);
      await getQueueRepository().freezeExecutionIdentity(
        msg.id,
        msg.fencingToken,
        identity,
      );
      Object.assign(msg, identity);
    } catch (error) {
      console.error(
        `[poller] 実行 identity の保存に失敗しました (${msg.id}):`,
        error,
      );
      await getQueueRepository().failAttempt(msg.id, error, msg.fencingToken, {
        metadata: { error },
      });
      settleRssDispatchAfterQueueTransition(msg);
      return;
    }
  }
  if (msg.cronDeliveryMode === "new-thread" || msg.cronThread) {
    try {
      return await processCronNewThread(msg, signal);
    } finally {
      settleRssDispatchAfterQueueTransition(msg);
    }
  }
  const timing = startResponseTiming(msg);
  let outcome: ResponseOutcome = "unexpected-error";
  // タイピング表示はロック取得後（withLlmLock の fn 内）に開始するため、
  // ここではプレースホルダを持ち、catch / finally の両方で停止できるようにする
  let stopTyping = () => {};
  try {
    let response: string;

    // グループ設定を先読みしてイベント通知と返信の送信設定を確定する
    const groupConfig = await findGroupByName(msg.groupName).catch((err) => {
      console.error("[poller] グループ設定の読み込みエラー:", err);
      return undefined;
    });
    if (!groupConfig) {
      outcome = "dead-letter";
      if (msg.fencingToken !== undefined) {
        await getQueueRepository().deadLetter(
          msg.id,
          msg.fencingToken,
          "config-unavailable",
          "group config unavailable",
          { termination: "spawn-error", stopReason: "config-unavailable" },
        );
      }
      return;
    }
    const replyMessageId = msg.messageId;

    try {
      const lockTarget = await resolveLlmLockTarget(msg, groupConfig?.model);
      response = await withLlmLock(
        lockTarget,
        async () => {
          stopTyping = startTypingLoop(msg.groupName, msg.channelId);
          const agentStartedAt = Date.now();
          try {
            return await sendMessage(
              msg.groupName,
              msg.sessionId,
              msg.content,
              {
                onDiscordEvent: (event) => {
                  // cron direct のツールコール通知はチャットが溜まるため抑制する
                  // (new-thread の場合はここに到達せず専用フローで処理される)
                  if (msg.cronJobId && event.type === "tool_start") {
                    return;
                  }
                  void sendDiscordEvent(
                    msg.groupName,
                    msg.channelId,
                    event,
                    replyMessageId,
                    groupConfig.allowMention === true,
                  );
                },
                attachments: msg.attachments,
                onExecutionTiming: (executionTiming) => {
                  timing.agentExecution = executionTiming;
                },
                onContainerStarted: markRunningWhenContainerStarted(
                  msg,
                  msg.sessionId,
                ),
                agentsSnapshotContent: msg.agentsSnapshotContent,
                agentsSnapshotPresent: msg.agentsSnapshotPresent,
                memorySnapshotPresent: msg.memorySnapshotPresent,
                memorySnapshotContent: msg.memorySnapshotContent,
                snapshotHash: msg.snapshotHash,
                toolCallKey: msg.toolCallKey,
                signal,
                configOverride: msg.configOverride,
              },
            );
          } finally {
            timing.agentTotalMs = Date.now() - agentStartedAt;
          }
        },
        {
          onAcquired: (waitMs) => {
            timing.lockWaitMs = waitMs;
          },
          signal,
        },
      );
    } catch (err) {
      stopTyping();
      if (err instanceof NonRetryableError) {
        outcome = "dead-letter";
        console.error(`[poller] 処理失敗（非リトライ可能）:`, err);
        await sendDiscordEvent(
          msg.groupName,
          msg.channelId,
          { type: "error", message: String(err) },
          replyMessageId,
          groupConfig.allowMention === true,
        );
        if (msg.fencingToken !== undefined) {
          await getQueueRepository().deadLetter(
            msg.id,
            msg.fencingToken,
            "non_retryable",
            String(err),
            executionMetadata(timing),
          );
        }
        return;
      }
      // リトライ方針（maxAttempts・指数バックオフ・retry_wait・dead-letter 遷移）は
      // QueueRepository が一括で所有する。poller は失敗を記録するだけで、リトライ戦略や
      // スリープは行わない（next_attempt_at が再 claim を制御する）。
      console.error(`[poller] 処理失敗:`, err);
      outcome = "retry";
      if (msg.fencingToken !== undefined) {
        await getQueueRepository().failAttempt(msg.id, err, msg.fencingToken, {
          metadata: executionMetadata(timing),
        });
        // 実行後の実際の遷移を観測してログのみを確定する（方針決定は repository 側）。
        const after = getQueueRepository().get(msg.id);
        if (after?.status === "dead_letter") outcome = "dead-letter";
      }
      return;
    }

    if (await failAttemptIfNonZeroExitCode(msg, response, timing)) return;
    if (await failAttemptIfEmptyRssResponse(msg, response, timing)) return;
    // Canonical result and durable delivery chunks commit atomically; Discord is never called here.
    if (msg.fencingToken === undefined) {
      throw new Error(`fenced inbox message required: ${msg.id}`);
    }
    await getQueueRepository().commitResult(
      msg.id,
      msg.fencingToken,
      response,
      {
        empty: !response,
        metadata: executionMetadata(timing),
        deliveryPayload: {
          groupName: msg.groupName,
          destinationType: "channel",
          destinationId: msg.channelId,
          replyMessageId,
          allowMention: groupConfig.allowMention === true,
        },
      },
    );
    outcome = response ? "success" : "empty-response";
    stopTyping();
  } finally {
    stopTyping();
    settleRssDispatchAfterQueueTransition(msg);
    logResponseTiming(msg, timing, outcome);
  }
}
async function poll(): Promise<void> {
  while (running) {
    try {
      if (discordReady()) {
        const msg = await getQueueRepository().claim(
          "poller-single-host",
          LEASE_MS,
          new Date(),
          inFlightIds,
        )?.job;
        if (msg) {
          dispatchClaimedMessage(msg);
          continue;
        }
      }
    } catch (err) {
      // ここで例外を握り潰さないと poll() の Promise が reject し、
      // fire-and-forget で呼ばれているため誰にも気づかれずポーラー全体が停止する（#152）
      console.error("[poller] poll ループで予期せぬエラー:", err);
    }
    await sleep(POLL_MS);
  }
}
