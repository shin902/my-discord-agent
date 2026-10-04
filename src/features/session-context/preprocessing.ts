import type {
  AgentMessage,
  AgentTool,
  CustomMessage,
} from "@earendil-works/pi-agent-core";
import { replaceSessionContext } from "../../agent/session.js";
import type { initializeSessionBootstrap } from "../../sandbox/session-bootstrap.js";
import { isSessionTimeAnchorMessage } from "../../sandbox/session-bootstrap.js";
import {
  type ContextOperation,
  compactSessionContext,
  contextArchiveId,
  estimateMessageTokens,
  estimatePreviousContextTokens,
  isCompactionMessage,
  isContextInitialization,
  loadContextSegments,
} from "./compaction.js";
import type { CompactionConfig } from "./config.js";

const COMPACTED =
  "コンテキストを圧縮しました。旧履歴はsession-logsで検索できます。";

export async function prepareSessionContext(
  groupName: string,
  sessionId: string,
  agentId: string,
  operation?: ContextOperation,
) {
  if (operation?.action && !operation.allowContextReset)
    throw new Error("appendUserOnly sessionではclear/compactを実行できません");
  const segments = await loadContextSegments(
    groupName,
    sessionId,
    agentId,
    "full",
  );
  const raw = segments.at(-1)?.messages ?? [];
  const alreadyApplied =
    operation !== undefined &&
    raw.some(
      (message) =>
        message.role === "custom" &&
        "operationId" in message &&
        message.operationId === operation.operationId,
    );
  if (operation?.action === "clear") {
    if (!alreadyApplied)
      await replaceSessionContext(
        groupName,
        sessionId,
        agentId,
        contextArchiveId(sessionId, operation.operationId),
        [
          {
            role: "custom",
            customType: "session-context-reset",
            content: "",
            display: false,
            timestamp: Date.now(),
            operationId: operation.operationId,
          } as CustomMessage,
        ],
      );
    return {
      messages: [],
      alreadyApplied,
      response:
        "コンテキストをクリアしました。旧履歴はsession-logsで検索できます。",
    };
  }
  return {
    messages:
      segments.length === 1
        ? raw
        : [
            ...raw.filter(isContextInitialization),
            ...segments.flatMap(({ messages }) =>
              messages.filter(
                (message) =>
                  !isContextInitialization(message) &&
                  (!isCompactionMessage(message) ||
                    message.contextMode === "full"),
              ),
            ),
          ],
    alreadyApplied,
    response:
      operation?.action === "compact" && alreadyApplied ? COMPACTED : undefined,
  };
}

export async function preprocessSessionContext(options: {
  groupName: string;
  sessionId: string;
  agentId: string;
  operation?: ContextOperation;
  alreadyApplied: boolean;
  bootstrap: Awaited<ReturnType<typeof initializeSessionBootstrap>>;
  historyMessages?: AgentMessage[];
  compaction: CompactionConfig;
  systemPrompt: string;
  tools: AgentTool[];
  prompt: string | AgentMessage[];
  execution: Parameters<typeof compactSessionContext>[0]["execution"];
  onUsage: Parameters<typeof compactSessionContext>[0]["onUsage"];
}) {
  const { operation, bootstrap, historyMessages, execution } = options;
  let messages =
    historyMessages === undefined
      ? bootstrap.messages
      : [...bootstrap.initialMessages, ...historyMessages];
  if (operation?.allowContextReset && !options.alreadyApplied) {
    const promptTokens =
      typeof options.prompt === "string"
        ? Math.ceil(options.prompt.length / 4)
        : options.prompt.reduce(
            (tokens, message) => tokens + estimateMessageTokens(message),
            0,
          );
    const projectedTokens = Math.max(
      estimateMessageTokens({
        role: "user",
        content:
          options.systemPrompt +
          JSON.stringify(
            options.tools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
            })),
          ),
        timestamp: Date.now(),
      }) +
        (await execution.convertToLlm(messages)).reduce(
          (tokens, message) => tokens + estimateMessageTokens(message),
          0,
        ) +
        promptTokens,
      historyMessages === undefined
        ? estimatePreviousContextTokens(messages) + promptTokens
        : 0,
    );
    if (
      operation.action === "compact" ||
      (options.compaction.enabled &&
        projectedTokens >
          execution.model.contextWindow * options.compaction.threshold)
    ) {
      const initialMessages = [...bootstrap.initialMessages];
      if (!initialMessages.some(isSessionTimeAnchorMessage))
        initialMessages.push({
          role: "custom",
          customType: "session-time-anchor",
          content: String(bootstrap.sessionAnchorTimestamp),
          display: false,
          timestamp: bootstrap.sessionAnchorTimestamp,
        });
      messages = await compactSessionContext({
        groupName: options.groupName,
        sessionId: options.sessionId,
        agentId: options.agentId,
        operationId: operation.operationId,
        messages,
        initialMessages,
        contextMode: historyMessages === undefined ? "full" : "final-only",
        compaction: options.compaction,
        execution,
        onUsage: options.onUsage,
        onStarted: operation.onCompactionStarted,
      });
    }
  }
  return {
    messages,
    response:
      operation?.action === "compact"
        ? messages.some(
            (message) =>
              isCompactionMessage(message) &&
              message.operationId === operation.operationId,
          )
          ? COMPACTED
          : "圧縮対象の古い履歴がありません。履歴はそのまま保持しています。"
        : undefined,
  };
}
