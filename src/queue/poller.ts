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
import { client } from "../discord/client.js";
import { NonRetryableError } from "../utils/error.js";
import * as inboxStore from "./inbox.js";
import {
  commitInboxResult,
  deadLetterInbox,
  failInboxAttempt,
  freezeInboxExecutionIdentity,
  type InboxMessage,
  markInboxRunning,
  updateInboxById,
} from "./inbox.js";
import type { ExecutionMetadata } from "./repository.js";
import { appendDeadLetter } from "./dead-letter.js";
import { acquireLlmLock } from "./llm-mutex.js";

const POLL_MS = 1000;
const MAX_RETRIES = 10;
const SLOW_RESPONSE_MS = 60_000;
let running = false;

type ResponseOutcome =
  | "success"
  | "empty-response"
  | "retry"
  | "dead-letter"
  | "discord-error"
  | "unexpected-error";

interface ResponseTiming {
  startedAt: number;
  receivedAt?: number;
  enqueuedAt?: number;
  queueWaitMs: number;
  lockWaitMs?: number;
  agentTotalMs?: number;
  agentExecution?: AgentExecutionTiming;
  discordSendMs?: number;
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
    ["discord-send", timing.discordSendMs],
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
    discordSendMs: timing.discordSendMs,
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

// Durable claims provide session ordering; this set only prevents duplicate in-process dispatch.
const inFlightIds = new Set<string>();

export function dispatch(sessionId: string, fn: () => Promise<void>): void {
  void fn().catch((err) =>
    console.error("[poller] 予期せぬエラー (sessionId:", sessionId, "):", err),
  );
}
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

function dispatchClaimedMessage(msg: InboxMessage): void {
  const controller = new AbortController();
  const renewal = setInterval(() => {
    void inboxStore
      .renewInboxLease(msg.id, msg.fencingToken ?? 0, LEASE_MS)
      .catch((error) => {
        console.error(`[poller] lease更新に失敗しました (${msg.id}):`, error);
        controller.abort(error);
      });
  }, LEASE_RENEWAL_MS);
  renewal.unref?.();
  inFlightIds.add(msg.id);
  dispatch(msg.sessionId, () =>
    processMessage(msg, controller.signal).finally(() => {
      clearInterval(renewal);
      inFlightIds.delete(msg.id);
    }),
  );
}

const TYPING_INTERVAL_MS = 8_000;

function startTypingLoop(channelId: string): () => void {
  let cancelled = false;
  let cancelSleep: (() => void) | null = null;

  const loop = async () => {
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
  channelId: string,
  event: DiscordEvent,
  replyMessageId?: string,
): Promise<void> {
  try {
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
    await channel.send(
      shouldReply
        ? {
            content,
            reply: {
              messageReference: replyMessageId,
              failIfNotExists: false,
            },
            allowedMentions: { repliedUser: true },
          }
        : content,
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

async function processCronNewThread(
  msg: InboxMessage,
  signal?: AbortSignal,
): Promise<void> {
  const timing = startResponseTiming(msg);
  let outcome: ResponseOutcome = "unexpected-error";
  const sessionId =
    msg.cronThreadId ?? (msg.cronThread ? msg.channelId : msg.sessionId);
  try {
    if (!msg.cronJobId) {
      outcome = "dead-letter";
      await appendDeadLetter(msg, "invalid_cron_job");
      await deadLetterInbox(
        msg.id,
        "invalid_cron_job",
        undefined,
        msg.fencingToken,
      );
      return;
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
            onContainerStarted: () =>
              msg.fencingToken === undefined
                ? undefined
                : markInboxRunning(msg.id, msg.fencingToken, {
                    startedAt: new Date().toISOString(),
                    workspacePath: `groups/${msg.groupName}`,
                    conversationPath: `data/sessions/${msg.groupName}/${sessionId}.jsonl`,
                  }),
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
    if (
      timing.agentExecution?.exitCode !== undefined &&
      timing.agentExecution.exitCode !== null &&
      timing.agentExecution.exitCode !== 0
    ) {
      await failInboxAttempt(
        msg.id,
        new Error(
          response ||
            `agent exited with code ${timing.agentExecution.exitCode}`,
        ),
        msg.fencingToken,
        executionMetadata(timing),
      );
      return;
    }
    if (msg.fencingToken !== undefined)
      await commitInboxResult(msg.id, msg.fencingToken, response, {
        empty: !response,
        metadata: executionMetadata(timing),
        deliveryPayload: {
          destinationType: "new-thread",
          destinationId: msg.channelId,
          cronJobId: msg.cronJobId,
          cronThreadId: msg.cronThreadId,
        },
      });
    outcome = response ? "success" : "empty-response";
  } catch (error) {
    if (error instanceof NonRetryableError) {
      outcome = "dead-letter";
      await appendDeadLetter(msg, "non_retryable");
      if (msg.fencingToken !== undefined)
        await deadLetterInbox(
          msg.id,
          "non_retryable",
          String(error),
          msg.fencingToken,
          undefined,
          executionMetadata(timing),
        );
    } else {
      outcome = "retry";
      if (msg.fencingToken !== undefined)
        await failInboxAttempt(
          msg.id,
          error,
          msg.fencingToken,
          executionMetadata(timing),
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
      await freezeInboxExecutionIdentity(msg.id, msg.fencingToken, identity);
      Object.assign(msg, identity);
    } catch (error) {
      console.error(
        `[poller] 実行 identity の保存に失敗しました (${msg.id}):`,
        error,
      );
      await failInboxAttempt(msg.id, error, msg.fencingToken, {
        termination: "spawn-error",
        stopReason: "identity-capture",
        error,
      });
      return;
    }
  }
  if (msg.cronDeliveryMode === "new-thread" || msg.cronThread) {
    return processCronNewThread(msg, signal);
  }
  const timing = startResponseTiming(msg);
  let outcome: ResponseOutcome = "unexpected-error";
  // タイピング表示はロック取得後（withLlmLock の fn 内）に開始するため、
  // ここではプレースホルダを持ち、catch / finally の両方で停止できるようにする
  let stopTyping = () => {};
  try {
    let response: string;

    // グループ設定を先読みしてイベント通知と返信の両方で autoReply を参照できるようにする
    const groupConfig = await findGroupByName(msg.groupName).catch((err) => {
      console.error("[poller] グループ設定の読み込みエラー:", err);
      return undefined;
    });
    if (!groupConfig) {
      outcome = "dead-letter";
      await deadLetterInbox(
        msg.id,
        "config-unavailable",
        "group config unavailable",
        msg.fencingToken,
        undefined,
        {
          termination: "spawn-error",
          stopReason: "config-unavailable",
        },
      );
      return;
    }
    const replyMessageId =
      groupConfig?.autoReply && msg.messageId ? msg.messageId : undefined;

    try {
      const lockTarget = await resolveLlmLockTarget(msg, groupConfig?.model);
      response = await withLlmLock(
        lockTarget,
        async () => {
          stopTyping = startTypingLoop(msg.channelId);
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
                  void sendDiscordEvent(msg.channelId, event, replyMessageId);
                },
                attachments: msg.attachments,
                onExecutionTiming: (executionTiming) => {
                  timing.agentExecution = executionTiming;
                },
                onContainerStarted: () =>
                  msg.fencingToken === undefined
                    ? undefined
                    : markInboxRunning(msg.id, msg.fencingToken, {
                        startedAt: new Date().toISOString(),
                        workspacePath: `groups/${msg.groupName}`,
                        conversationPath: `data/sessions/${msg.groupName}/${msg.sessionId}.jsonl`,
                      }),
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
        await appendDeadLetter(msg, "non_retryable");
        if (msg.fencingToken !== undefined) {
          await inboxStore.deadLetterInbox(
            msg.id,
            "non_retryable",
            String(err),
            msg.fencingToken,
            undefined,
            executionMetadata(timing),
          );
        }
        return;
      }
      console.error(
        `[poller] 処理失敗 (リトライ ${msg.retries}/${MAX_RETRIES}):`,
        err,
      );
      if (msg.retries + 1 < MAX_RETRIES) {
        outcome = "retry";
        await updateInboxById(
          msg.id,
          { retries: msg.retries + 1, lastError: String(err) },
          msg.fencingToken,
          undefined,
          executionMetadata(timing),
        );
      } else {
        outcome = "dead-letter";
        console.error(
          "[poller] リトライ上限に達しました。dead-letter に移動:",
          msg.id,
        );
        await appendDeadLetter(msg, "max_attempts");
        if (msg.fencingToken !== undefined) {
          await inboxStore.deadLetterInbox(
            msg.id,
            "max_attempts",
            String(err),
            msg.fencingToken,
            undefined,
            executionMetadata(timing),
          );
        }
      }
      const retryDelay = Math.min(1000 * 2 ** msg.retries, 60000);
      await sleep(retryDelay);
      return;
    }

    if (
      timing.agentExecution?.exitCode !== undefined &&
      timing.agentExecution.exitCode !== null &&
      timing.agentExecution.exitCode !== 0
    ) {
      await failInboxAttempt(
        msg.id,
        new Error(
          response ||
            `agent exited with code ${timing.agentExecution.exitCode}`,
        ),
        msg.fencingToken,
        executionMetadata(timing),
      );
      return;
    }
    // Canonical result and durable delivery chunks commit atomically; Discord is never called here.
    if (msg.fencingToken === undefined) {
      throw new Error(`fenced inbox message required: ${msg.id}`);
    }
    await commitInboxResult(msg.id, msg.fencingToken, response, {
      empty: !response,
      metadata: executionMetadata(timing),
      deliveryPayload: {
        destinationType: "channel",
        destinationId: msg.channelId,
        replyMessageId,
      },
    });
    outcome = response ? "success" : "empty-response";
    stopTyping();
  } finally {
    stopTyping();
    logResponseTiming(msg, timing, outcome);
  }
}
async function poll(): Promise<void> {
  while (running) {
    try {
      if (client.isReady()) {
        const msg = await inboxStore.claimInbox(
          "poller-single-host",
          LEASE_MS,
          inFlightIds,
        );
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
