import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type AgentExecutionTiming,
  type DiscordEvent,
  sendMessage,
} from "../agent/manager.js";
import {
  isAgentMemoryEligible,
  loadAgentMemoryConfig,
} from "../config/agent-memory.js";
import { resolveAgentConfig } from "../config/agent-resolution.js";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import { resolveModelConfig } from "../config/default-model.js";
import { loadGroupSystemPrompt } from "../config/group-config.js";
import {
  type AgentConfig,
  findGroupByChannelIdFresh,
  findGroupByName,
  type GroupConfig,
  type ModelConfig,
} from "../config/groups.js";
import {
  type ProviderConcurrency,
  resolveProviderConcurrency,
} from "../config/providers.js";
import { provisionCronItemThread } from "../cron/enqueue.js";
import { acknowledgeEmail } from "../cron/mail-ack.js";
import {
  getDiscordClientForGroupName,
  getDiscordClients,
} from "../discord/client.js";
import {
  AgentMemoryClient,
  AgentMemoryHttpError,
  buildAgentMemoryAdmission,
  buildAgentMemorySubmission,
  isCurrentAgentMemoryAdmission,
} from "../memory/agent-memory.js";
import { NonRetryableError } from "../utils/error.js";
import { classifyDiscordError, DeliveryError } from "./delivery.js";
import { acquireLlmLock } from "./llm-mutex.js";
import { settleRssDispatch } from "./reconciliation.js";
import { type ExecutionMetadata, getQueueRepository } from "./repository.js";
import type { InboxMessage } from "./types.js";

const POLL_MS = 1000;
const SLOW_RESPONSE_MS = 60_000;
let running = false;

type ResponseOutcome = "success" | "retry" | "dead-letter" | "unexpected-error";

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
        systemPromptSnapshotHash: execution.systemPromptSnapshotHash,
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

const NO_REPLY_SYSTEM_PROMPT =
  "通知すべき内容がない場合は、独立した行に <NO_REPLY> とだけ出力してください。";

function hasNoReplyMarker(response: string): boolean {
  return response.split(/\r?\n/).some((line) => line.trim() === "<NO_REPLY>");
}

function isEmptyAgentResponse(response: string): boolean {
  return response.trim().length === 0;
}

async function finalizeSuppressedSource(msg: InboxMessage): Promise<void> {
  if (msg.mailEmailId) {
    try {
      await acknowledgeEmail(msg.mailEmailId);
    } catch (error) {
      console.error(
        `[poller] 無配信mailの既読化に失敗しました (${msg.id}):`,
        error,
      );
    }
  }

  if (!msg.rssDispatchId) return;
  try {
    const settled = settleRssDispatch(
      msg.rssStatePath,
      msg.rssDispatchId,
      msg.idempotencyKey,
      "completed",
    );
    if (settled === 1) return;
    throw new Error("RSS dispatch claim was not found or could not be opened");
  } catch (settleError) {
    console.error(
      `[poller] 無配信RSSの確定に失敗しました (${msg.id}):`,
      settleError,
    );
    try {
      const released = settleRssDispatch(
        msg.rssStatePath,
        msg.rssDispatchId,
        msg.idempotencyKey,
        "dead_letter",
      );
      if (released !== 1) {
        throw new Error(
          "RSS dispatch claim was not found or could not be opened",
        );
      }
    } catch (releaseError) {
      console.error(
        `[poller] 無配信RSSのclaim解放にも失敗しました (${msg.id}):`,
        releaseError,
      );
    }
  }
}

function settleRssDispatchAfterQueueTransition(msg: InboxMessage): void {
  // RSS success is settled by the Discord delivery worker, not queue completion.
  // This keeps the article unread until the post actually exists in Discord.
  if (!msg.rssDispatchId) return;
  if (
    msg.cronDeliveryMode === "direct" ||
    msg.cronDeliveryMode === "new-thread" ||
    msg.cronDeliveryMode === "item-thread"
  )
    return;
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

async function processMemoryShadowJob(msg: InboxMessage): Promise<void> {
  if (msg.fencingToken === undefined || msg.memoryShadow === undefined) return;
  try {
    const config = await loadAgentMemoryConfig();
    const currentMapping = await findGroupByChannelIdFresh(msg.channelId);
    const admission = msg.memoryShadowAdmission;
    if (
      !config.enabled ||
      !config.eligibleGroups.includes(msg.groupName) ||
      currentMapping?.group.name !== msg.groupName ||
      admission === undefined ||
      !isCurrentAgentMemoryAdmission(admission, config, msg) ||
      msg.memoryShadow.scope.teamId !== admission.teamId ||
      msg.memoryShadow.scope.agentId !== admission.agentId ||
      msg.memoryShadow.scope.userId !== admission.userId ||
      msg.memoryShadow.scope.sessionId !== admission.sessionId
    ) {
      console.log(
        `[agent-memory] shadow job skipped (disabled/revoked/rotated): ${msg.id}`,
      );
      await getQueueRepository().commitResult(msg.id, msg.fencingToken, "", {
        suppressDelivery: true,
      });
      return;
    }
    const result = await new AgentMemoryClient(config).addConversation(
      msg.memoryShadow,
    );
    await getQueueRepository().commitResult(msg.id, msg.fencingToken, "", {
      suppressDelivery: true,
    });
    console.log(
      `[agent-memory] shadow submission accepted: ${JSON.stringify({ jobId: msg.id, requestId: result.requestId, totalCount: result.totalCount })}`,
    );
  } catch (error) {
    console.error(`[agent-memory] shadow submission failed: ${msg.id}`, error);
    if (error instanceof AgentMemoryHttpError && !error.retryable) {
      getQueueRepository().deadLetter(
        msg.id,
        msg.fencingToken,
        "non_retryable",
        String(error),
      );
    } else if (error instanceof NonRetryableError) {
      getQueueRepository().deadLetter(
        msg.id,
        msg.fencingToken,
        "non_retryable",
        String(error),
      );
    } else {
      getQueueRepository().failAttempt(msg.id, error, msg.fencingToken);
    }
    const after = getQueueRepository().get(msg.id);
    if (after?.status === "dead_letter")
      console.error(
        `[agent-memory] shadow submission dead-lettered: ${msg.id}`,
      );
  }
}

async function prepareMemoryShadowJob(
  msg: InboxMessage,
  assistantContent: string,
): Promise<
  | {
      payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">;
      options: { idempotencyKey: string };
      userId: string;
    }
  | undefined
> {
  const config = await loadAgentMemoryConfig();
  if (!isAgentMemoryEligible(config, msg) || msg.content.trim().length === 0)
    return undefined;
  const userId = msg.userId;
  if (!userId) return undefined;
  const submission = buildAgentMemorySubmission({
    teamId: config.teamId,
    agentId: config.agentId,
    userId,
    sessionId: msg.sessionId,
    userContent: msg.content,
    assistantContent,
    userTimestamp: msg.timestamp,
    assistantTimestamp: new Date().toISOString(),
  });
  return {
    payload: {
      channelId: msg.channelId,
      groupName: msg.groupName,
      sessionId: `memory-shadow:${msg.sessionId}`,
      content: "memory-shadow",
      timestamp: new Date().toISOString(),
      memoryShadow: submission,
      memoryShadowAdmission: buildAgentMemoryAdmission({
        groupName: msg.groupName,
        channelId: msg.channelId,
        baseUrl: config.baseUrl,
        serviceId: config.serviceId,
        teamId: config.teamId,
        agentId: config.agentId,
        ...(config.bearerTokenEnv
          ? { bearerTokenEnv: config.bearerTokenEnv }
          : {}),
        userId,
        sessionId: msg.sessionId,
      }),
    },
    options: { idempotencyKey: `agent-memory-shadow:${msg.id}` },
    userId,
  };
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

function isDiscordProgressEvent(event: DiscordEvent): boolean {
  return (
    event.type === "tool_start" ||
    event.type === "subagent_tool_start" ||
    event.type === "subagent_update"
  );
}

function isDirectCronMessage(msg: InboxMessage): boolean {
  // Legacy cron payloads may not have cronDeliveryMode, but cron messages that
  // do not use either thread route have always used direct channel delivery.
  return (
    msg.cronJobId !== undefined &&
    msg.cronDeliveryMode !== "new-thread" &&
    msg.cronDeliveryMode !== "item-thread" &&
    msg.cronThread !== true
  );
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
    } else if (event.type === "subagent_tool_start") {
      text = `🤖 ${event.worker} \`${event.runId.slice(0, 8)}\`: 🔧 \`${event.toolName}\``;
    } else if (event.type === "subagent_update") {
      const detail =
        event.status === "completed" && event.resultPreview
          ? `完了: ${event.resultPreview}`
          : event.status === "failed"
            ? "失敗"
            : event.taskPreview;
      text = `🤖 ${event.worker} \`${event.runId.slice(0, 8)}\`: ${detail}`;
    } else if (event.type === "error") {
      text = `⚠️ エラー: ${event.message}`;
    } else {
      // Keep the runtime boundary defensive if an untyped event reaches this
      // function despite the DiscordEvent union and manager validation.
      return;
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

async function resolveBotExecution(
  msg: InboxMessage,
  groupConfig: GroupConfig | undefined,
): Promise<{
  configOverride?: Partial<AgentConfig>;
  systemPromptAppend?: string;
}> {
  if (!msg.botId) return { configOverride: msg.configOverride };
  if (!groupConfig)
    throw new NonRetryableError(
      `Bot ${msg.botId} のグループ設定が未定義です: ${msg.groupName}`,
    );
  const registry = await loadBotRegistry();
  try {
    const profile = resolveBotProfile(registry, msg.botId, groupConfig.name);
    return {
      configOverride: resolveAgentConfig(groupConfig, profile),
      systemPromptAppend: profile.instructions,
    };
  } catch (error) {
    throw new NonRetryableError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function resolveLlmLockTarget(
  msg: InboxMessage,
  groupModel?: ModelConfig,
  configOverride = msg.configOverride,
): Promise<LlmLockTarget> {
  const model = await resolveModelConfig(
    resolveAgentConfig({ model: groupModel }, configOverride).model,
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

// 非ゼロ終了コードの扱いは通常メッセージと cron thread delivery で同一のため共通化する。
// リトライ方針の決定は QueueRepository が所有するため、poller は記録するだけ。
async function releaseRssAfterFailure(
  msg: InboxMessage,
  reason: string,
  timing: ResponseTiming,
): Promise<void> {
  if (!msg.rssDispatchId || msg.fencingToken === undefined) return;
  await getQueueRepository().deadLetter(
    msg.id,
    msg.fencingToken,
    reason,
    undefined,
    executionMetadata(timing),
  );
  settleRssDispatch(
    msg.rssStatePath,
    msg.rssDispatchId,
    msg.idempotencyKey,
    "dead_letter",
  );
}

async function failEmptyAgentResponse(
  msg: InboxMessage,
  timing: ResponseTiming,
): Promise<void> {
  if (msg.rssDispatchId) {
    await releaseRssAfterFailure(msg, "empty_response", timing);
  } else {
    if (msg.fencingToken === undefined) {
      throw new Error(`fenced inbox message required: ${msg.id}`);
    }
    await getQueueRepository().deadLetter(
      msg.id,
      msg.fencingToken,
      "empty_response",
      undefined,
      executionMetadata(timing),
    );
  }
  await finalizeCronFailure(msg);
}

async function failAttemptIfNonZeroExitCode(
  msg: InboxMessage,
  response: string,
  timing: ResponseTiming,
): Promise<boolean> {
  const exitCode = timing.agentExecution?.exitCode;
  if (exitCode === undefined || exitCode === null || exitCode === 0) {
    return false;
  }
  if (msg.rssDispatchId) {
    await releaseRssAfterFailure(msg, "agent_exit", timing);
    await finalizeCronFailure(msg);
  } else {
    await getQueueRepository().failAttempt(
      msg.id,
      new Error(response || `agent exited with code ${exitCode}`),
      msg.fencingToken,
      { metadata: executionMetadata(timing) },
    );
    if (getQueueRepository().get(msg.id)?.status === "dead_letter") {
      await finalizeCronFailure(msg);
    }
  }
  return true;
}

// コンテナ起動を running 状態として記録する onContainerStarted ハンドラを生成する。
// 通常メッセージ（sessionId=msg.sessionId）と cron thread delivery（導出 sessionId）で同一。
export async function reconcileTerminalCronFailures(): Promise<void> {
  const repo = getQueueRepository();
  const jobs = repo.listTerminalCronJobs();
  for (const job of jobs) {
    if (job.cronFailureNotified) continue;
    await finalizeCronFailure(job);
  }
}

function isCronItemMessage(msg: InboxMessage): boolean {
  return msg.cronDeliveryMode === "item-thread";
}

async function finalizeCronFailure(msg: InboxMessage): Promise<void> {
  if (!isCronItemMessage(msg)) return;
  try {
    await markCronFailurePlaceholder(msg);
  } finally {
    try {
      getQueueRepository().patchJobPayload(msg.id, {
        cronFailureNotified: true,
      });
      msg.cronFailureNotified = true;
    } catch (error) {
      console.error(
        `[poller] cron failure notification state update failed (${msg.id}):`,
        error,
      );
    }
  }
}

async function markCronFailurePlaceholder(msg: InboxMessage): Promise<boolean> {
  if (msg.cronDeliveryMode !== "item-thread") return false;
  if (!msg.cronPlaceholderMessageId) return false;
  try {
    const client = await getDiscordClientForGroupName(msg.groupName);
    const channel = (await client.channels.fetch(msg.channelId)) as unknown as {
      messages?: {
        fetch: (
          id: string,
        ) => Promise<{ edit?: (content: string) => Promise<unknown> }>;
      };
    };
    const message = await channel?.messages?.fetch(
      msg.cronPlaceholderMessageId,
    );
    if (!message?.edit) throw new Error("cron failure placeholder unavailable");
    await message.edit("⚠️ 処理に失敗しました");
    return true;
  } catch (error) {
    console.error(
      `[poller] cron failure placeholder 更新失敗 (${msg.id}):`,
      error,
    );
    return false;
  }
}

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
      (msg.cronThread === true ||
        msg.cronDeliveryMode === "new-thread" ||
        msg.cronDeliveryMode === "item-thread"))
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

async function ensureCronItemThread(msg: InboxMessage): Promise<void> {
  if (
    msg.cronDeliveryMode !== "item-thread" ||
    (msg.cronThreadId &&
      msg.cronPlaceholderMessageId &&
      msg.cronProvisioning !== true &&
      msg.sessionId === msg.cronThreadId)
  )
    return;
  if (msg.fencingToken === undefined) return;
  const repository = getQueueRepository();
  const job = repository.get(msg.id);
  if (!job)
    throw new Error(`[cron-item-thread] job ${msg.id} が見つかりません`);
  const client = await resolveDiscordClient(msg.groupName);
  const provisioned = await provisionCronItemThread(client, repository, job, {
    threadName: `cron-${String(msg.cronJobId ?? msg.id).slice(0, 90)}`,
  });
  msg.cronDeliveryMode = "item-thread";
  msg.cronSessionMode = "destination";
  msg.cronThread = true;
  msg.cronProvisioning = false;
  msg.cronThreadId = provisioned.cronThreadId;
  msg.cronPlaceholderMessageId = provisioned.cronPlaceholderMessageId;
  msg.sessionId = provisioned.sessionId;
}

async function processCronThreadDelivery(
  msg: InboxMessage,
  signal?: AbortSignal,
): Promise<void> {
  const timing = startResponseTiming(msg);
  let outcome: ResponseOutcome = "unexpected-error";
  let sessionId = cronSessionId(msg);
  try {
    // cronProvisioning=true is the new late-materialization state: the agent
    // runs in its temporary session and Discord is untouched until delivery.
    // Legacy item-thread jobs without that marker still use the old provisioner.
    if (
      msg.cronDeliveryMode === "item-thread" &&
      msg.cronProvisioning !== true &&
      (!msg.cronThreadId ||
        !msg.cronPlaceholderMessageId ||
        msg.sessionId !== msg.cronThreadId)
    ) {
      await ensureCronItemThread(msg);
      sessionId = cronSessionId(msg);
    }
    if (!msg.cronJobId) {
      outcome = "dead-letter";
      if (msg.fencingToken !== undefined) {
        await getQueueRepository().deadLetter(
          msg.id,
          msg.fencingToken,
          "invalid_cron_job",
        );
        await finalizeCronFailure(msg);
      }
      return;
    }
    // item-thread materializes only after a non-suppressed response exists.
    // new-thread keeps its existing destination-session behavior.
    if (
      !msg.rssDispatchId &&
      msg.cronDeliveryMode !== "item-thread" &&
      usesCronDestinationSession(msg)
    ) {
      await ensureCronThread(msg);
      sessionId = cronSessionId(msg);
    }
    const groupConfig = await findGroupByName(msg.groupName);
    const execution = await resolveBotExecution(msg, groupConfig);
    const lockTarget = await resolveLlmLockTarget(
      msg,
      groupConfig?.model,
      execution.configOverride,
    );
    const legacyItemThread =
      msg.cronDeliveryMode === "item-thread" && msg.cronProvisioning !== true;
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
            configOverride: execution.configOverride,
            systemPromptSnapshotContent: msg.systemPromptSnapshotContent,
            systemPromptSnapshotPresent: msg.systemPromptSnapshotPresent,
            memorySnapshotPresent: msg.memorySnapshotPresent,
            memorySnapshotContent: msg.memorySnapshotContent,
            snapshotHash: msg.snapshotHash,
            toolCallKey: msg.toolCallKey,
            systemPromptAppend:
              execution.systemPromptAppend ??
              (msg.cronNoReply && !legacyItemThread
                ? NO_REPLY_SYSTEM_PROMPT
                : undefined),
            heldLlmProvider:
              lockTarget.concurrency === "serial"
                ? lockTarget.provider
                : undefined,
            ...(msg.botId ? { enableBotTool: false } : {}),
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
    if (isEmptyAgentResponse(response)) {
      outcome = "dead-letter";
      await failEmptyAgentResponse(msg, timing);
      return;
    }
    const suppressDelivery = !legacyItemThread && hasNoReplyMarker(response);
    const lateItemThread =
      msg.cronDeliveryMode === "item-thread" && msg.cronProvisioning === true;
    if (msg.fencingToken !== undefined)
      await getQueueRepository().commitResult(
        msg.id,
        msg.fencingToken,
        response,
        {
          empty: !response,
          suppressDelivery,
          metadata: executionMetadata(timing),
          deliveryPayload: {
            groupName: msg.groupName,
            destinationType: lateItemThread ? "item-thread" : "new-thread",
            destinationId: msg.channelId,
            cronJobId: msg.cronJobId,
            cronThreadId: lateItemThread ? undefined : msg.cronThreadId,
            cronPlaceholderMessageId: lateItemThread
              ? undefined
              : msg.cronPlaceholderMessageId,
            ...(msg.mailEmailId ? { mailEmailId: msg.mailEmailId } : {}),
            ...(msg.rssDispatchId
              ? {
                  rssDispatchId: msg.rssDispatchId,
                  rssStatePath: msg.rssStatePath,
                  rssDispatchJobId: msg.idempotencyKey,
                }
              : {}),
          },
        },
      );
    if (suppressDelivery) await finalizeSuppressedSource(msg);
    outcome = "success";
  } catch (error) {
    if (msg.rssDispatchId) {
      outcome = "dead-letter";
      await releaseRssAfterFailure(msg, "agent_error", timing);
      await finalizeCronFailure(msg);
      return;
    }
    const ambiguousMutation =
      error instanceof DeliveryError && error.kind === "unknown";
    const nonRetryable =
      error instanceof NonRetryableError ||
      (error instanceof DeliveryError && error.kind === "non-retryable");
    if (ambiguousMutation || nonRetryable) {
      outcome = "dead-letter";
      if (msg.fencingToken !== undefined)
        await getQueueRepository().deadLetter(
          msg.id,
          msg.fencingToken,
          ambiguousMutation ? "ambiguous_cron_thread" : "non_retryable",
          String(error),
          executionMetadata(timing),
        );
      await finalizeCronFailure(msg);
    } else {
      outcome = "retry";
      if (msg.fencingToken !== undefined) {
        await getQueueRepository().failAttempt(
          msg.id,
          error,
          msg.fencingToken,
          { metadata: executionMetadata(timing) },
        );
        if (getQueueRepository().get(msg.id)?.status === "dead_letter") {
          await finalizeCronFailure(msg);
        }
      }
    }
  } finally {
    logResponseTiming({ ...msg, sessionId }, timing, outcome);
  }
}
async function captureFrozenIdentity(msg: InboxMessage): Promise<{
  systemPromptSnapshotContent?: string;
  memorySnapshotContent?: string;
  systemPromptSnapshotPresent: boolean;
  memorySnapshotPresent: boolean;
  snapshotPresent: boolean;
  snapshotHash: string;
  toolCallKey: string;
}> {
  const readOptional = async (file: string) =>
    readFile(file, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
  let systemPromptSnapshotContent =
    (await loadGroupSystemPrompt(msg.groupName, { refresh: true })) ??
    undefined;
  let memorySnapshotContent = await readOptional(
    path.join("groups", msg.groupName, "memory", "MEMORY.md"),
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
        if (
          entry.customType === "system-prompt-snapshot" ||
          entry.customType === "agents-snapshot"
        )
          systemPromptSnapshotContent = String(entry.content ?? "");
        if (entry.customType === "memory-bootstrap")
          memorySnapshotContent = String(entry.content ?? "");
      } catch {
        /* ignore malformed historical lines */
      }
    }
  }
  const systemPromptSnapshotPresent = systemPromptSnapshotContent !== undefined;
  const memorySnapshotPresent = memorySnapshotContent !== undefined;
  const snapshotPresent = systemPromptSnapshotPresent || memorySnapshotPresent;
  const canonicalMemory =
    memorySnapshotContent === undefined
      ? ""
      : memorySnapshotContent.startsWith("## Memory (MEMORY.md)\n\n")
        ? memorySnapshotContent
        : `## Memory (MEMORY.md)\n\n${Array.from(memorySnapshotContent).slice(0, 2000).join("")}${Array.from(memorySnapshotContent).length > 2000 ? "\n\n[Warning: Memory (MEMORY.md) exceeds the limit (2000 characters). Delete or summarize old content to keep it organized]" : ""}`;
  const snapshotHash = createHash("sha256")
    .update(
      `${systemPromptSnapshotPresent ? "1" : "0"}:${systemPromptSnapshotContent ?? ""}:${memorySnapshotPresent ? "1" : "0"}:${canonicalMemory}`,
    )
    .digest("hex");
  const toolCallKey = createHash("sha256")
    .update(`${msg.id}:${msg.groupName}:${msg.sessionId}:${snapshotHash}`)
    .digest("hex");
  return {
    systemPromptSnapshotContent,
    memorySnapshotContent,
    systemPromptSnapshotPresent,
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
  if (msg.memoryShadow !== undefined) {
    await processMemoryShadowJob(msg);
    return;
  }
  if (msg.fencingToken !== undefined) {
    try {
      const identity =
        msg.snapshotHash &&
        msg.toolCallKey &&
        msg.systemPromptSnapshotPresent !== undefined
          ? {
              systemPromptSnapshotContent: msg.systemPromptSnapshotContent,
              memorySnapshotContent: msg.memorySnapshotContent,
              systemPromptSnapshotPresent: msg.systemPromptSnapshotPresent,
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
  if (
    msg.cronDeliveryMode === "new-thread" ||
    msg.cronDeliveryMode === "item-thread" ||
    msg.cronThread
  ) {
    try {
      return await processCronThreadDelivery(msg, signal);
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
      if (msg.rssDispatchId) {
        await releaseRssAfterFailure(msg, "config-unavailable", timing);
      } else if (msg.fencingToken !== undefined) {
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
      const execution = await resolveBotExecution(msg, groupConfig);
      const lockTarget = await resolveLlmLockTarget(
        msg,
        groupConfig.model,
        execution.configOverride,
      );
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
                  // direct cron の実行進捗はチャネルを埋めるため抑制する。
                  // エラーは必要な通知として維持し、thread delivery は専用フローに委ねる。
                  if (
                    isDirectCronMessage(msg) &&
                    isDiscordProgressEvent(event)
                  ) {
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
                systemPromptSnapshotContent: msg.systemPromptSnapshotContent,
                systemPromptSnapshotPresent: msg.systemPromptSnapshotPresent,
                memorySnapshotPresent: msg.memorySnapshotPresent,
                memorySnapshotContent: msg.memorySnapshotContent,
                snapshotHash: msg.snapshotHash,
                toolCallKey: msg.toolCallKey,
                systemPromptAppend:
                  execution.systemPromptAppend ??
                  (msg.cronNoReply ? NO_REPLY_SYSTEM_PROMPT : undefined),
                signal,
                configOverride: execution.configOverride,
                heldLlmProvider:
                  lockTarget.concurrency === "serial"
                    ? lockTarget.provider
                    : undefined,
                ...(msg.botId ? { enableBotTool: false } : {}),
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
      if (msg.rssDispatchId) {
        outcome = "dead-letter";
        await releaseRssAfterFailure(msg, "agent_error", timing);
        return;
      }
      if (err instanceof NonRetryableError) {
        outcome = "dead-letter";
        console.error(`[poller] 処理失敗（非リトライ可能）:`, err);
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
    if (isEmptyAgentResponse(response)) {
      outcome = "dead-letter";
      await failEmptyAgentResponse(msg, timing);
      return;
    }
    const suppressDelivery = hasNoReplyMarker(response);
    // Canonical result and durable delivery chunks commit atomically; Discord is never called here.
    if (msg.fencingToken === undefined) {
      throw new Error(`fenced inbox message required: ${msg.id}`);
    }
    let shadowJob:
      | {
          payload: Omit<InboxMessage, "id" | "retries" | "enqueuedAt">;
          options: { idempotencyKey: string };
          userId: string;
        }
      | undefined;
    try {
      shadowJob = await prepareMemoryShadowJob(msg, response);
    } catch (error) {
      // Shadow mode is best-effort; configuration/preparation failures must not
      // prevent the normal response from reaching its terminal state.
      console.error(
        `[agent-memory] shadow job preparation failed: ${msg.id}`,
        error,
      );
    }
    await getQueueRepository().commitResult(
      msg.id,
      msg.fencingToken,
      response,
      {
        empty: !response,
        suppressDelivery,
        metadata: executionMetadata(timing),
        deliveryPayload: {
          groupName: msg.groupName,
          destinationType: "channel",
          destinationId: msg.channelId,
          replyMessageId,
          allowMention: groupConfig.allowMention === true,
          ...(msg.mailEmailId ? { mailEmailId: msg.mailEmailId } : {}),
          ...(msg.rssDispatchId
            ? {
                rssDispatchId: msg.rssDispatchId,
                rssStatePath: msg.rssStatePath,
                rssDispatchJobId: msg.idempotencyKey,
              }
            : {}),
        },
        ...(shadowJob
          ? {
              shadowJob: {
                payload: shadowJob.payload,
                options: shadowJob.options,
              },
            }
          : {}),
      },
    );
    if (suppressDelivery) await finalizeSuppressedSource(msg);
    if (shadowJob) {
      console.log(
        `[agent-memory] shadow job admitted: ${JSON.stringify({ sourceJobId: msg.id, groupName: msg.groupName, userId: shadowJob.userId })}`,
      );
    }
    // The source result, delivery rows, and local shadow admission commit
    // atomically. The queued worker owns remote MemoryCore I/O separately.
    outcome = "success";
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
        await reconcileTerminalCronFailures();
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
