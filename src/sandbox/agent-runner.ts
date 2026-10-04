import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  type Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type CustomMessage,
  convertToLlm as libraryConvertToLlm,
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  Usage,
} from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { z } from "zod";

import {
  CONVERSATION_ENTRIES_PREFIX,
  type ConversationEntries,
} from "../agent/conversation.js";
import { resolveModel } from "../agent/model.js";
import { appendMessage, loadMessages } from "../agent/session.js";
import { type SessionSource, SessionSourceSchema } from "../agent/source.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import {
  type AgentRuntimeConfig,
  AgentRuntimeConfigSchema,
} from "../config/groups.js";
import { convertInitialMemoryToLlm } from "../features/agent-memory/memory-context.js";
import {
  type ContextOperation,
  expandCompaction,
} from "../features/session-context/compaction.js";
import {
  type CompactionConfig,
  CompactionConfigSchema,
} from "../features/session-context/config.js";
import {
  prepareSessionContext,
  preprocessSessionContext,
} from "../features/session-context/preprocessing.js";
import {
  formatSkillCommandPrompt,
  parseSkillCommand,
} from "../skills/command.js";
import { parseYamlFrontmatter } from "../skills/loader.js";
import { resolveTools } from "../tools/registry.js";
import type { ToolProxyEndpoint } from "../tools/tool-proxy.js";
import { isTransientError } from "../utils/error.js";
import { runAgent } from "./agent-execution.js";
import { type BotToolConfig, createBotTool } from "./bot.js";
import {
  buildBootstrapSystemPrompt,
  CONTEXT_BOOTSTRAP_TYPES,
  type ContextBootstrapMessage,
  type FrozenExecutionIdentity,
  getCustomType,
  initializeSessionBootstrap,
  isSessionTimeAnchorMessage,
  isSystemPromptSnapshotMessage,
} from "./session-bootstrap.js";
import {
  createSteeringController,
  STEERING_INSTRUCTION_TYPE,
} from "./steering.js";
import {
  createRootDelegationLineage,
  createSubagentTool,
  type SubagentRun,
} from "./subagent.js";

const SKILL_INVOCATION_TYPE = "skill-invocation";
type SkillInvocationMessage = Omit<CustomMessage, "content"> & {
  customType: typeof SKILL_INVOCATION_TYPE;
  content: string;
};

export { DEFAULT_SYSTEM_PROMPT } from "./session-bootstrap.js";

const STEER_ACK_PREFIX = "__AGENT_STEER_ACK__:";

type RunnerLineHandler = (line: string) => void;

/**
 * Route the first stdin line as the run payload and retain every subsequent
 * line until the control handler is installed. Readline can deliver the
 * payload and an immediately-following steer in one chunk, so installing a
 * second `line` listener after awaiting the payload would lose that steer.
 */
export function createRunnerLineRouter(onPayloadLine: RunnerLineHandler): {
  handleLine: RunnerLineHandler;
  setControlHandler: (handler: RunnerLineHandler) => void;
} {
  let payloadSeen = false;
  let controlHandler: RunnerLineHandler | undefined;
  const pendingControlLines: string[] = [];

  return {
    handleLine(line) {
      if (!payloadSeen) {
        payloadSeen = true;
        onPayloadLine(line);
        return;
      }
      if (controlHandler) controlHandler(line);
      else pendingControlLines.push(line);
    },
    setControlHandler(handler) {
      controlHandler = handler;
      for (const line of pendingControlLines.splice(0)) handler(line);
    },
  };
}

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "role" in msg &&
    (msg as Record<string, unknown>).role === "assistant"
  );
}

type AgentTokenUsage = Pick<
  Usage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens"
>;

function addTokenUsage(
  total: AgentTokenUsage,
  usage: Pick<Usage, keyof AgentTokenUsage>,
): AgentTokenUsage {
  return {
    input: total.input + usage.input,
    output: total.output + usage.output,
    cacheRead: total.cacheRead + usage.cacheRead,
    cacheWrite: total.cacheWrite + usage.cacheWrite,
    totalTokens: total.totalTokens + usage.totalTokens,
  };
}

function isSkillInvocationMessage(
  msg: AgentMessage,
): msg is SkillInvocationMessage {
  return msg.role === "custom" && msg.customType === SKILL_INVOCATION_TYPE;
}

/** カスタムプロバイダーの API キーを credential-proxy + 環境変数から取得 */
async function getCustomProviderApiKey(
  provider: string,
): Promise<string | undefined> {
  try {
    const entries = await loadCredentialProxy();
    const entry = entries.find((e) => e.provider === provider);
    if (!entry) return undefined;
    // Select the SDK's OAuth wire format without exposing the host token.
    if (entry.sdkAuth === "anthropic-oauth")
      return "sk-ant-oat-proxy-placeholder";
    if (!entry.envVars || entry.envVars.length === 0) return "local";
    for (const envVar of entry.envVars) {
      const value = process.env[envVar];
      if (value) return value;
    }
  } catch (err) {
    console.error(
      `[agent-runner] credential-proxy の読み込みに失敗: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return undefined;
}

type ReadToolDetails = {
  path?: unknown;
  size?: unknown;
  characters?: unknown;
  returnedCharacters?: unknown;
  startLine?: unknown;
  endLine?: unknown;
  returnedLineCount?: unknown;
  totalLines?: unknown;
  eof?: unknown;
  truncated?: unknown;
  externalizedOutput?: unknown;
};

function isExternalizedReadDetails(details: ReadToolDetails): boolean {
  if (details.truncated === true) return true;
  if (
    typeof details.externalizedOutput === "object" &&
    details.externalizedOutput !== null
  ) {
    return (
      (details.externalizedOutput as { truncated?: unknown }).truncated === true
    );
  }
  return false;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** read の行位置・総量を details から LLM が読めるテキストへ変換する。 */
function formatReadToolDetails(msg: AgentMessage): string | undefined {
  if (msg.role !== "toolResult" || msg.toolName !== "read") return undefined;
  if (typeof msg.details !== "object" || msg.details === null) return undefined;

  const details = msg.details as ReadToolDetails;
  // The common output wrapper may preserve the original read range in details
  // while replacing the actual content with a temporary-file notice. Do not
  // claim that the range was delivered (especially EOF) in that case; the
  // notice itself tells the model to read the externalized file.
  if (isExternalizedReadDetails(details)) return undefined;
  if (
    typeof details.path !== "string" ||
    !isFiniteNumber(details.size) ||
    !isFiniteNumber(details.totalLines) ||
    !isFiniteNumber(details.startLine) ||
    !isFiniteNumber(details.endLine) ||
    !isFiniteNumber(details.returnedLineCount) ||
    typeof details.eof !== "boolean"
  ) {
    return undefined;
  }

  const returnedCharacters = isFiniteNumber(details.returnedCharacters)
    ? `、今回の返却は ${details.returnedCharacters} 文字`
    : "";
  const range =
    details.returnedLineCount === 0
      ? "0 行"
      : `${details.startLine}〜${details.endLine} 行（${details.returnedLineCount} 行）`;
  const continuation = details.eof
    ? "EOFまで読み込み済み"
    : `続きは ${details.endLine + 1} 行目から`;

  return [
    "",
    `[read メタデータ: ${details.path}]`,
    `ファイル全体: ${details.size} 文字、${details.totalLines} 行`,
    `今回の読み込み: ${range}${returnedCharacters}`,
    continuation,
  ].join("\n");
}

function isSteeringInstructionMessage(message: AgentMessage): boolean {
  return (
    message.role === "custom" &&
    message.customType === STEERING_INSTRUCTION_TYPE
  );
}

function decorateToolResultForLlm(msg: AgentMessage): AgentMessage {
  const metadata = formatReadToolDetails(msg);
  if (!metadata || msg.role !== "toolResult") return msg;
  return {
    ...msg,
    content: [...msg.content, { type: "text", text: metadata }],
  };
}

/** AgentMessage[] を LLM 送信用 Message[] に変換する。
 * - systemPromptSnapshot: systemPrompt の組み立てにのみ使うため、チャット履歴からは常に除外する。
 * - contextBootstrap（memoryBootstrap / selfBootstrap）: customType ごとに最初の1件のみ
 *   user として展開し、残りは除外する（セッションあたり1件しか書き込まれないため、
 *   実質的にフィルタが発動するケースはない）。
 * - skillInvocation と steering-instruction は、LLM に届く指示内容を保持するため user として展開する。
 * - それ以外（bashExecution・branchSummary・compactionSummary・他の customType 等）は
 *   pi-agent-core 標準の convertToLlm に委譲する。未知の role を無効なまま LLM へ渡さないため。 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  const bootstrapSeen = new Set<string>();
  return expandCompaction(messages).flatMap((msg) => {
    if (
      getCustomType(msg) === "session-context-reset" ||
      isSystemPromptSnapshotMessage(msg) ||
      isSessionTimeAnchorMessage(msg)
    )
      return [];
    const memoryMessages = convertInitialMemoryToLlm(msg, bootstrapSeen);
    if (memoryMessages !== undefined) return memoryMessages;
    const customType = getCustomType(msg);
    if (customType && CONTEXT_BOOTSTRAP_TYPES.has(customType)) {
      if (bootstrapSeen.has(customType)) return [];
      bootstrapSeen.add(customType);
      const content = (msg as ContextBootstrapMessage).content;
      return [{ role: "user", content, timestamp: msg.timestamp }];
    }
    if (isSkillInvocationMessage(msg)) {
      return [{ role: "user", content: msg.content, timestamp: msg.timestamp }];
    }
    if (customType === STEERING_INSTRUCTION_TYPE) {
      const content = (msg as CustomMessage).content;
      return [{ role: "user", content, timestamp: msg.timestamp }];
    }
    return libraryConvertToLlm([decorateToolResultForLlm(msg)]);
  });
}

export type { FrozenExecutionIdentity } from "./session-bootstrap.js";
export async function runAgentLoop(
  groupName: string,
  sessionId: string,
  content: string,
  groupConfig: AgentRuntimeConfig,
  identity: FrozenExecutionIdentity,
  systemPromptAppend?: string,
  botToolConfig?: BotToolConfig,
  onAgentCreated?: (agent: Agent) => void,
  signal?: AbortSignal,
  toolProxyEndpoint?: ToolProxyEndpoint,
  source?: SessionSource,
  onConversation?: (entries: ConversationEntries) => void,
  imagePaths?: string[],
  historyMessages?: AgentMessage[],
  contextOperation?: ContextOperation,
  compaction: CompactionConfig = CompactionConfigSchema.parse({}),
): Promise<string> {
  const modelConfig = groupConfig.model;
  if (!modelConfig) {
    throw new Error("実行モデルが設定されていません");
  }

  const persistMessage = (
    message: AgentMessage,
    entrySource?: SessionSource,
  ) =>
    entrySource
      ? appendMessage(
          groupName,
          sessionId,
          message,
          identity.agentId,
          entrySource,
        )
      : appendMessage(groupName, sessionId, message, identity.agentId);
  const context = await prepareSessionContext(
    groupName,
    sessionId,
    identity.agentId,
    contextOperation,
  );
  if (context.response !== undefined) return context.response;
  const bootstrap = await initializeSessionBootstrap(
    groupName,
    sessionId,
    context.messages,
    groupConfig,
    identity,
  );
  const { skills } = bootstrap;

  // `./command スキル名` 形式のメッセージは、LLMの自律判断を待たずに
  // 指定スキルのSKILL.md本文をそのままプロンプトへ強制注入して実行させる。
  // ユーザーの生発言は content のまま user メッセージとして残し、
  // 注入指示は別の skill-invocation custom メッセージに分離する
  // （session trajectory上で「何を打ったか」と「LLMに渡った指示」を区別できるようにするため）。
  let promptInput: string | AgentMessage[] = content;
  if (imagePaths?.length) {
    const images: ImageContent[] = [];
    for (const imagePath of imagePaths) {
      images.push({
        type: "image",
        data: (await readFile(imagePath)).toString("base64"),
        mimeType: "image/png",
      });
    }
    promptInput = [
      {
        role: "user",
        content: [{ type: "text", text: content }, ...images],
        timestamp: Date.now(),
      } as AgentMessage,
    ];
  }
  const skillCommand = parseSkillCommand(content);
  if (skillCommand) {
    const skill = skills.find((s) => s.name === skillCommand.skillName);
    if (!skill) {
      const available = skills.map((s) => s.name).join(", ") || "(なし)";
      const response = `❌ スキル "${skillCommand.skillName}" が見つかりません。利用可能なスキル: ${available}`;
      const userEntryId = await persistMessage(
        { role: "user", content, timestamp: Date.now() },
        source,
      );
      const assistantEntryId = await persistMessage({
        role: "assistant",
        content: [{ type: "text", text: response }],
        api: "local-response",
        provider: "local",
        model: "skill-command",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      onConversation?.({ userEntryId, assistantEntryId });
      return response;
    }
    const skillFile = await readFile(skill.location, "utf-8");
    const { body: skillBody } = parseYamlFrontmatter(skillFile);
    const skillInvocationMessage: SkillInvocationMessage = {
      role: "custom",
      customType: SKILL_INVOCATION_TYPE,
      content: formatSkillCommandPrompt(
        skillCommand.skillName,
        skillBody,
        skillCommand.args,
      ),
      display: false,
      timestamp: Date.now(),
    };
    promptInput = [
      {
        role: "user",
        content: [{ type: "text", text: content }],
        timestamp: Date.now(),
      } as AgentMessage,
      skillInvocationMessage,
    ];
  }

  const model = await resolveModel(modelConfig.provider, modelConfig.modelId);

  const {
    fullSystemPrompt,
    snapshotHashValue,
    toolCallKey,
    systemPromptSnapshotHash,
    memorySnapshotHash,
  } = buildBootstrapSystemPrompt(
    groupName,
    sessionId,
    content,
    groupConfig,
    identity,
    systemPromptAppend,
    bootstrap,
  );

  const rootRun = createRootDelegationLineage();
  const getApiKey = (provider: string) => {
    // KnownProvider: pi-ai の環境変数マッピングを使用
    const knownKey = getEnvApiKey(provider);
    if (knownKey) return knownKey;

    // カスタムプロバイダー: credential-proxy.json を読んで envVars から取得
    return getCustomProviderApiKey(provider);
  };
  const delegationContext = {
    parentRun: rootRun,
    systemPrompt: fullSystemPrompt,
    model,
    tools: [] as AgentTool[],
    thinkingLevel: groupConfig.model?.thinkingLevel ?? "off",
    convertToLlm: defaultConvertToLlm,
    getApiKey,
    onEvent: (run: SubagentRun, event: AgentEvent) => {
      if (event.type === "message_end" && isAssistantMessage(event.message)) {
        assistantTurns++;
        if (event.message.usage) {
          aggregatedUsage = addTokenUsage(aggregatedUsage, event.message.usage);
          hasUsage = true;
        }
        return;
      }
      if (event.type !== "tool_execution_start") return;
      const payload: Record<string, unknown> = {
        type: "subagent_tool_start",
        worker: "ephemeral",
        runId: run.id,
        parentRunId: run.parentRunId,
        toolName: event.toolName,
        taskPreview: run.taskPreview,
      };
      process.stderr.write(`__DISCORD_EVENT__:${JSON.stringify(payload)}\n`);
    },
  };
  const agentTools = resolveTools(
    groupConfig.tools ?? [],
    {
      subagent: () =>
        groupConfig.tools?.includes("subagent") === true
          ? createSubagentTool(delegationContext)
          : undefined,
      bot: () =>
        botToolConfig && groupConfig.tools?.includes("bot") === true
          ? createBotTool({
              ...botToolConfig,
              groupName,
              onUsage: (usage) => {
                aggregatedUsage = addTokenUsage(aggregatedUsage, usage);
                hasUsage = true;
              },
            })
          : undefined,
    },
    { toolProxyEndpoint },
  );
  delegationContext.tools = agentTools;

  let assistantTurns = 0;
  let aggregatedUsage: AgentTokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  let hasUsage = false;
  const promptStartedAt = Date.now();
  const pendingAppends: Promise<void>[] = [];
  let sourceAttached = false;
  let userEntryId: number | undefined;
  let assistantEntryId: number | undefined;
  let response = "";
  let stopReason: string | undefined;

  // runAgent owns Agent construction and prompt execution. This callback keeps
  // persistent-session concerns (append and Discord event formatting) here.
  try {
    const prepared = await preprocessSessionContext({
      groupName,
      sessionId,
      agentId: identity.agentId,
      operation: contextOperation,
      alreadyApplied: context.alreadyApplied,
      bootstrap,
      historyMessages,
      compaction,
      systemPrompt: fullSystemPrompt,
      tools: agentTools,
      prompt: promptInput,
      execution: {
        model,
        convertToLlm: defaultConvertToLlm,
        getApiKey,
        signal,
      },
      onUsage: (usage) => {
        aggregatedUsage = addTokenUsage(aggregatedUsage, usage);
        assistantTurns++;
        hasUsage = true;
      },
    });
    if (prepared.response !== undefined) return prepared.response;
    const execution = await runAgent({
      systemPrompt: fullSystemPrompt,
      model,
      messages: prepared.messages,
      tools: agentTools,
      thinkingLevel: groupConfig.model?.thinkingLevel ?? "off",
      prompt: promptInput,
      convertToLlm: defaultConvertToLlm,
      getApiKey,
      sessionId,
      signal,
      onAgentCreated,
      onEvent: (event) => {
        if (
          event.type === "message_end" &&
          isSteeringInstructionMessage(event.message)
        ) {
          return;
        }
        if (event.type === "message_end") {
          const entrySource =
            !sourceAttached && event.message.role === "user"
              ? source
              : undefined;
          if (event.message.role === "user") sourceAttached = true;
          // Preserve event order in the canonical store, including user provenance.
          const previous = pendingAppends.at(-1) ?? Promise.resolve();
          const append = previous.then(async () => {
            const id = await persistMessage(event.message, entrySource);
            if (event.message.role === "user") userEntryId ??= id;
            if (isAssistantMessage(event.message)) {
              // Match runAgent's actual final assistant, regardless of downstream eligibility.
              // The host decides whether this result commits; projections select from it.
              assistantEntryId = id;
            }
          });
          // Observe rejection immediately; Promise.all below still propagates it.
          void append.catch(() => {});
          pendingAppends.push(append);
          if (isAssistantMessage(event.message)) {
            assistantTurns++;
            stopReason = event.message.stopReason;
            if (event.message.usage) {
              aggregatedUsage = addTokenUsage(
                aggregatedUsage,
                event.message.usage,
              );
              hasUsage = true;
            }
            if (event.message.errorMessage) {
              process.stderr.write(
                `__DISCORD_EVENT__:${JSON.stringify({ type: "error", message: event.message.errorMessage })}\n`,
              );
            } else {
              response = event.message.content
                .filter((c): c is TextContent => c.type === "text")
                .map((c) => c.text)
                .join("");
            }
          }
        }

        if (event.type === "tool_execution_start") {
          const payload: Record<string, unknown> = {
            type: "tool_start",
            toolName: event.toolName,
          };
          if (groupConfig.toolLogArgs) payload.args = event.args;
          process.stderr.write(
            `__DISCORD_EVENT__:${JSON.stringify(payload)}\n`,
          );
        }

        if (
          event.type === "tool_execution_update" &&
          event.toolName === "subagent"
        ) {
          const partialDetails =
            typeof event.partialResult === "object" &&
            event.partialResult !== null &&
            "details" in event.partialResult
              ? event.partialResult.details
              : undefined;
          const partialContent = Array.isArray(event.partialResult.content)
            ? event.partialResult.content
                .filter(
                  (
                    content: unknown,
                  ): content is { type: "text"; text: string } =>
                    typeof content === "object" &&
                    content !== null &&
                    "type" in content &&
                    content.type === "text" &&
                    "text" in content &&
                    typeof content.text === "string",
                )
                .map((content: { type: "text"; text: string }) => content.text)
                .join("")
            : undefined;
          const payload: Record<string, unknown> = {
            type: "subagent_update",
            ...(typeof partialDetails === "object" && partialDetails !== null
              ? partialDetails
              : {}),
            ...(partialContent ? { message: partialContent } : {}),
          };
          process.stderr.write(
            `__DISCORD_EVENT__:${JSON.stringify(payload)}\n`,
          );
        }
      },
    });
    response = execution.response;
  } finally {
    const timingEvent = {
      type: "agent_timing",
      promptMs: Date.now() - promptStartedAt,
      assistantTurns,
      ...(hasUsage ? { usage: aggregatedUsage } : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
      systemPromptSnapshotHash,
      memorySnapshotHash,
      snapshotHash: snapshotHashValue,
      toolCallKey,
    };
    const timingLine = `__DISCORD_EVENT__:${JSON.stringify(timingEvent)}\n`;
    const flushed = process.stderr.write(timingLine);
    if (flushed === false) {
      await new Promise<void>((resolve) => {
        process.stderr.once("drain", resolve);
      });
    }
    await Promise.all(pendingAppends);
  }
  if (userEntryId !== undefined && assistantEntryId !== undefined) {
    onConversation?.({ userEntryId, assistantEntryId });
  }
  return response;
}

const PayloadSchema = z.object({
  compaction: CompactionConfigSchema,
  groupName: z.string(),
  sessionId: z.string(),
  agentId: z.string().min(1),
  content: z.string(),
  contextOperation: z
    .object({
      action: z.enum(["clear", "compact"]).optional(),
      operationId: z.string().min(1),
      allowContextReset: z.boolean(),
    })
    .optional(),
  imagePaths: z.array(z.string().startsWith("/workspace/")).optional(),
  source: SessionSourceSchema.optional(),
  historyMessages: z
    .array(
      z.custom<AgentMessage>(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "role" in value &&
          ["user", "assistant", "toolResult", "custom"].includes(
            String(value.role),
          ),
      ),
    )
    .optional(),
  groupConfig: AgentRuntimeConfigSchema,
  systemPromptSnapshotContent: z.string().optional(),
  systemPromptSnapshotPresent: z.boolean().optional(),
  memorySnapshotPresent: z.boolean().optional(),
  memorySnapshotContent: z.string().optional(),
  snapshotHash: z.string().optional(),
  toolCallKey: z.string().optional(),
  systemPromptAppend: z.string().optional(),
  botToolConfig: z
    .object({
      endpoint: z.object({ url: z.string().url(), token: z.string().min(1) }),
      bots: z.array(
        z.object({
          id: z.string().min(1),
          description: z.string().trim().min(1),
        }),
      ),
    })
    .optional(),
  toolProxyEndpoint: z
    .object({ url: z.string().url(), token: z.string().min(1) })
    .optional(),
});

// CLIエントリポイント（import時は実行しない）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    const input = createInterface({ input: process.stdin });
    let resolvePayload!: (payload: z.infer<typeof PayloadSchema>) => void;
    let rejectPayload!: (error: unknown) => void;
    const payloadPromise = new Promise<z.infer<typeof PayloadSchema>>(
      (resolve, reject) => {
        resolvePayload = resolve;
        rejectPayload = reject;
      },
    );
    const lineRouter = createRunnerLineRouter((line) => {
      try {
        resolvePayload(PayloadSchema.parse(JSON.parse(line || "{}")));
      } catch (error) {
        rejectPayload(error);
      }
    });
    input.on("line", lineRouter.handleLine);
    input.on("error", rejectPayload);
    process.stderr.write("__AGENT_READY__\n");
    if (process.argv.includes("--session-store-smoke")) {
      const groupName = "runner-smoke";
      const sessionId = "append-load";
      const message: AgentMessage = {
        role: "user",
        content: "runner image session store smoke test",
        timestamp: Date.now(),
      };
      await appendMessage(groupName, sessionId, message, "main");
      const loaded = await loadMessages(groupName, sessionId, "main");
      if (
        loaded.length !== 1 ||
        loaded[0]?.role !== "user" ||
        loaded[0].content !== "runner image session store smoke test"
      ) {
        throw new Error("session store smoke test append/load mismatch");
      }
      process.stderr.write("__SESSION_STORE_SMOKE_OK__\n");
      input.close();
      return;
    }
    const payload = await payloadPromise;
    const abortController = new AbortController();

    const steering = createSteeringController(
      payload.groupName,
      payload.sessionId,
      payload.agentId,
    );
    const sendSteerAck = (requestId: string, accepted: boolean): void => {
      process.stderr.write(
        `${STEER_ACK_PREFIX}${JSON.stringify({
          type: "steer_ack",
          requestId,
          accepted,
        })}\n`,
      );
    };
    lineRouter.setControlHandler((line) => {
      void (async () => {
        try {
          const control = JSON.parse(line) as {
            type?: unknown;
            requestId?: unknown;
            instruction?: unknown;
          };
          if (control.type === "abort") {
            abortController.abort();
            return;
          }
          if (typeof control.requestId !== "string") return;
          const validInstruction =
            control.type === "steer" &&
            typeof control.instruction === "string" &&
            control.instruction.length > 0 &&
            control.instruction.length <= 4000;
          const accepted = validInstruction
            ? await steering.receive(control.instruction as string)
            : false;
          sendSteerAck(control.requestId, accepted);
        } catch {
          // Ignore malformed control frames; stdin is not a general command API.
        }
      })();
    });

    let activeAnnounced = false;
    const announceActive = () => {
      if (!activeAnnounced) process.stderr.write("__AGENT_ACTIVE__\n");
      activeAnnounced = true;
    };
    let response: string;
    try {
      response = await runAgentLoop(
        payload.groupName,
        payload.sessionId,
        payload.content,
        payload.groupConfig,
        payload,
        payload.systemPromptAppend,
        payload.botToolConfig,
        (agent) => {
          steering.attach(agent);
          announceActive();
        },
        abortController.signal,
        payload.toolProxyEndpoint,
        payload.source,
        (entries) => {
          process.stderr.write(
            `${CONVERSATION_ENTRIES_PREFIX}${JSON.stringify(entries)}\n`,
          );
        },
        payload.imagePaths,
        payload.historyMessages,
        payload.contextOperation
          ? { ...payload.contextOperation, onCompactionStarted: announceActive }
          : undefined,
        payload.compaction,
      );
    } catch (error) {
      // Initialization failures must reject pre-attach requests without
      // persisting a steer that never reached an Agent.
      steering.close();
      throw error;
    }
    // Stop accepting steering before waiting for trajectory persistence;
    // Agent.steer() cannot resume a completed run.
    steering.close();
    await new Promise<void>((resolve, reject) => {
      process.stderr.write("__AGENT_RUN_COMPLETE__\n", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    await steering.waitForPersistence();
    // pi-agent-core/pi-ai 側がHTTPクライアントのkeep-aliveソケット等を残し、
    // イベントループが自然に空にならずプロセスがexitしないケースがある。
    // ホスト側（manager.ts）は proc の close イベントを10分タイムアウトで
    // 待っているため、自然終了に任せると応答済みでもSIGKILLされてDiscordに
    // 届かなくなる。write完了を待って明示的にexitし、確実にcloseさせる。
    await new Promise<void>((resolve) => {
      process.stdout.write(response, () => resolve());
    });
    process.exit(0);
  })().catch((err) => {
    const transient = isTransientError(err);
    const code = transient ? 2 : 1;
    process.stderr.write(
      `agent-runner エラー${transient ? "（一時的）" : ""}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(code);
  });
}
