import { ChannelType } from "discord.js";
import {
  type AgentExecutionTiming,
  type DiscordEvent,
  sendMessage,
} from "../agent/manager.js";
import { findGroupByName } from "../config/groups.js";
import {
  type DispatchMode,
  loadDispatchMode,
} from "../config/poller-config.js";
import { client } from "../discord/client.js";
import { NonRetryableError } from "../utils/error.js";
import { splitMessage } from "../utils/splitMessage.js";
import { appendDeadLetter } from "./dead-letter.js";
import {
  type InboxMessage,
  peekAllUnclaimedInbox,
  removeInboxById,
  updateInboxById,
} from "./inbox.js";
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

const sessionChain = new Map<string, Promise<void>>();
// peekAllUnclaimedInbox() で claim 済み（処理中 / セッションチェーンで順番待ち中）のメッセージID。
// 処理が完全に終わる（removeInboxById / updateInboxById）まで inbox.jsonl から削除しないため、
// 同じメッセージを再度 claim しないようにここで追跡する。
const inFlightIds = new Set<string>();

export function dispatch(sessionId: string, fn: () => Promise<void>): void {
  const onError = (err: unknown) => {
    console.error("[poller] 予期せぬエラー (sessionId:", sessionId, "):", err);
  };
  const prev = sessionChain.get(sessionId) ?? Promise.resolve();
  const next = prev.then(fn).catch(onError);
  sessionChain.set(sessionId, next);
  next.finally(() => {
    if (sessionChain.get(sessionId) === next) sessionChain.delete(sessionId);
  });
}

export function startPoller(): void {
  if (running) return;
  running = true;
  poll();
}

export function stopPoller(): void {
  running = false;
  sessionChain.clear();
  inFlightIds.clear();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
}

async function withLlmLock<T>(
  mode: DispatchMode,
  fn: () => Promise<T>,
  options: LlmLockOptions = {},
): Promise<T> {
  const waitStartedAt = Date.now();
  const release = await acquireLlmLock(mode);
  try {
    options.onAcquired?.(Date.now() - waitStartedAt);
    return await fn();
  } finally {
    release();
  }
}

async function processCronNewThread(
  msg: InboxMessage,
  mode: DispatchMode,
): Promise<void> {
  const timing = startResponseTiming(msg);
  let outcome: ResponseOutcome = "unexpected-error";
  let sessionId = msg.sessionId;
  // cronSessionMode がない旧 cronThread メッセージは従来どおりスレッドIDを使う。
  const sessionMode = msg.cronSessionMode ?? "destination";
  try {
    if (!msg.cronJobId) {
      outcome = "dead-letter";
      console.error(
        "[poller] cronThread フラグがあるが cronJobId が未設定:",
        msg,
      );
      await appendDeadLetter(msg);
      await removeInboxById(msg.id);
      return;
    }
    // try の外で宣言: catch ブロックで cronThreadId として引き継ぐため
    let threadId: string | undefined;
    let response: string;
    let threadSend: (content: string) => Promise<unknown>;
    try {
      if (msg.cronThreadId) {
        // リトライ: スレッドは作成済み。再作成せず既存スレッドをフェッチ
        threadId = msg.cronThreadId;
        if (sessionMode === "destination") sessionId = threadId;
        const fetched = await client.channels.fetch(threadId);
        if (!fetched?.isSendable()) {
          throw new NonRetryableError(
            `cron-thread: スレッド ${threadId} が見つかりません`,
          );
        }
        threadSend = (content) => fetched.send(content);
      } else {
        // 初回: チャンネルをフェッチしてスレッドを作成
        const channel = await client.channels.fetch(msg.channelId);
        if (
          !channel ||
          (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement)
        ) {
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
        const maxIdLen = 100 - "cron-".length - suffix.length;
        const truncatedId = msg.cronJobId.slice(0, maxIdLen);
        const thread = await channel.threads.create({
          name: `cron-${truncatedId}${suffix}`,
        });
        threadId = thread.id;
        if (sessionMode === "destination") sessionId = thread.id;
        threadSend = (content) => thread.send(content);
      }
      response = await withLlmLock(
        mode,
        async () => {
          const agentStartedAt = Date.now();
          try {
            return await sendMessage(msg.groupName, sessionId, msg.content, {
              onExecutionTiming: (executionTiming) => {
                timing.agentExecution = executionTiming;
              },
              configOverride: msg.configOverride,
            });
          } finally {
            timing.agentTotalMs = Date.now() - agentStartedAt;
          }
        },
        {
          onAcquired: (waitMs) => {
            timing.lockWaitMs = waitMs;
          },
        },
      );
    } catch (err) {
      if (err instanceof NonRetryableError) {
        outcome = "dead-letter";
        console.error("[poller] cron-thread 処理失敗（非リトライ可能）:", err);
        await appendDeadLetter(msg);
        await removeInboxById(msg.id);
      } else {
        console.error(
          `[poller] cron-thread 処理失敗 (リトライ ${msg.retries}/${MAX_RETRIES}):`,
          err,
        );
        if (msg.retries + 1 < MAX_RETRIES) {
          outcome = "retry";
          // threadId がセット済み（スレッド作成後に失敗）なら次回リトライでスレッド再作成をスキップ
          await updateInboxById(msg.id, {
            retries: msg.retries + 1,
            cronThreadId: threadId,
          });
        } else {
          outcome = "dead-letter";
          console.error(
            "[poller] cron-thread リトライ上限。dead-letter に移動:",
            msg.id,
          );
          await appendDeadLetter(msg);
          await removeInboxById(msg.id);
        }
      }
      return;
    }

    // LLM 呼び出しが成功した時点で inbox から削除する。以降の Discord 送信失敗は
    // ログのみで再実行しない（processMessage と同様、応答自体は生成済みのため）
    await removeInboxById(msg.id);

    const discordSendStartedAt = Date.now();
    try {
      if (response) {
        for (const chunk of splitMessage(response)) {
          await threadSend(chunk);
        }
        outcome = "success";
      } else {
        outcome = "empty-response";
      }
    } catch (err) {
      outcome = "discord-error";
      console.error("[poller] cron-thread Discord送信エラー:", err);
    } finally {
      timing.discordSendMs = Date.now() - discordSendStartedAt;
    }
  } finally {
    logResponseTiming({ ...msg, sessionId }, timing, outcome);
  }
}

export async function processMessage(
  msg: InboxMessage,
  mode: DispatchMode,
): Promise<void> {
  if (msg.cronDeliveryMode === "new-thread" || msg.cronThread) {
    return processCronNewThread(msg, mode);
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
    const replyMessageId =
      groupConfig?.autoReply && msg.messageId ? msg.messageId : undefined;

    try {
      response = await withLlmLock(
        mode,
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
        },
      );
    } catch (err) {
      stopTyping();
      if (err instanceof NonRetryableError) {
        outcome = "dead-letter";
        console.error(`[poller] 処理失敗（非リトライ可能）:`, err);
        await appendDeadLetter(msg);
        await removeInboxById(msg.id);
        return;
      }
      console.error(
        `[poller] 処理失敗 (リトライ ${msg.retries}/${MAX_RETRIES}):`,
        err,
      );
      if (msg.retries + 1 < MAX_RETRIES) {
        outcome = "retry";
        await updateInboxById(msg.id, { retries: msg.retries + 1 });
      } else {
        outcome = "dead-letter";
        console.error(
          "[poller] リトライ上限に達しました。dead-letter に移動:",
          msg.id,
        );
        await appendDeadLetter(msg);
        await removeInboxById(msg.id);
      }
      const retryDelay = Math.min(1000 * 2 ** msg.retries, 60000);
      await sleep(retryDelay);
      return;
    }

    // LLM 呼び出しが成功した時点で inbox から削除する。以降の Discord 送信失敗は
    // ログのみで dead-letter には送らない（応答自体は生成済みのため再実行は不要）
    await removeInboxById(msg.id);

    const discordSendStartedAt = Date.now();
    try {
      const channel = await client.channels.fetch(msg.channelId);
      if (!response) {
        outcome = "empty-response";
      } else if (!channel?.isSendable()) {
        outcome = "discord-error";
        console.error(
          `[poller] Discord送信エラー: チャンネル ${msg.channelId} は送信できません`,
        );
      } else {
        const chunks = splitMessage(response);
        const [firstChunk, ...restChunks] = chunks;
        if (firstChunk) {
          await channel.send(
            replyMessageId
              ? {
                  content: firstChunk,
                  reply: {
                    messageReference: replyMessageId,
                    failIfNotExists: false,
                  },
                  allowedMentions: { repliedUser: true },
                }
              : firstChunk,
          );
        }
        for (const chunk of restChunks) {
          await channel.send(chunk);
        }
        outcome = "success";
      }
    } catch (err) {
      outcome = "discord-error";
      console.error(`[poller] Discord送信エラー:`, err);
    } finally {
      timing.discordSendMs = Date.now() - discordSendStartedAt;
      stopTyping();
    }
  } finally {
    stopTyping();
    logResponseTiming(msg, timing, outcome);
  }
}

async function poll(): Promise<void> {
  const mode = await loadDispatchMode();
  while (running) {
    try {
      if (client.isReady()) {
        // in-flight のメッセージはファイルに残り続けるため、1回の読み込みで
        // 未claim分を全部取得してまとめて dispatch する（1件ずつ読み直すと
        // in-flight が溜まるほど無駄な読み込み・パースが増えるため）
        const msgs = await peekAllUnclaimedInbox(inFlightIds);
        if (msgs.length > 0) {
          for (const msg of msgs) {
            // claim: 処理が完全に終わるまで inbox.jsonl から削除しない
            // （同一セッション内で順番待ち中でも消えないようにするため）
            inFlightIds.add(msg.id);
            dispatch(msg.sessionId, () =>
              processMessage(msg, mode).finally(() => {
                inFlightIds.delete(msg.id);
              }),
            );
          }
          // ノンブロッキングで dispatch 済み → 即次のバッチを取りに行く
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
