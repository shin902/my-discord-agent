import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
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
import {
  type AssistantMessage,
  getEnvApiKey,
  type Message,
  type TextContent,
  type Usage,
} from "@earendil-works/pi-ai";
import { z } from "zod";

import { resolveModel } from "../agent/model.js";
import { appendMessage, loadMessages } from "../agent/session.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { FALLBACK_DEFAULT_MODEL } from "../config/default-model.js";
import {
  type AgentRuntimeConfig,
  AgentRuntimeConfigSchema,
} from "../config/groups.js";
import {
  formatSkillCommandPrompt,
  parseSkillCommand,
} from "../skills/command.js";
import { loadSkills, parseYamlFrontmatter } from "../skills/loader.js";
import { formatSkillsForPrompt } from "../skills/prompt.js";
import { formatSessionTimeAnchor } from "../time/context.js";
import { resolveTools } from "../tools/registry.js";
import { isTransientError } from "../utils/error.js";
import { runAgent } from "./agent-execution.js";
import { type BotToolEndpoint, createBotTool } from "./bot.js";
import {
  createSteeringController,
  STEERING_INSTRUCTION_TYPE,
} from "./steering.js";
import {
  createRootDelegationLineage,
  createSubagentTool,
  type SubagentRun,
} from "./subagent.js";
import { loadGroupSystemPrompt } from "./system-prompt.js";

export { runEphemeralAgent } from "./subagent.js";

// pi-agent-core が標準提供する CustomMessage（role: "custom"）を customType で使い分ける:
// - "system-prompt-snapshot": グループの system prompt をセッション初回に固定化するためのスナップショット。
//   役割上は system 相当として扱うため、LLM へのチャット履歴には乗せず systemPrompt の組み立てにのみ使う。
// - "memory-bootstrap": MEMORY.md をセッション初回に注入する擬似ユーザーメッセージ。
// - "self-bootstrap": /workspace/memory/SELF.md をセッション初回に注入する擬似ユーザーメッセージ。
//   MEMORY.md（過去の事象＝書き換え不可の記録）とはカテゴリを分け、SELF.md は
//   「現在の自分が過去をどう解釈するか」を表す可変の人格記述として別枠で扱う
//   （docs/todo/issue-persona-growth.md 参照）。強制力は system prompt 側の記述が持ち、
//   SELF.md 自体はコンテキスト側の参照情報にとどめる。
// - "skill-invocation": `./command` で明示実行されたスキルの SKILL.md 本文を注入する擬似ユーザーメッセージ。
//   ユーザーの生発言（`./command スキル名 ...`）とは別メッセージとして保存することで、
//   JSONL履歴上でも「ユーザーが何を打ったか」と「LLMに渡った指示内容」を区別できるようにする。
//
// display フラグについて: 標準 CustomMessage の必須フィールドで、pi-coding-agent 系 TUI が
// チャット表示の可否判定に使う。LLM 送信可否（defaultConvertToLlm 側で制御）とは別概念。
// うちはその TUI を使わないため実質無効だが、いずれも裏方メッセージなので意味的に false 固定。
const SYSTEM_PROMPT_SNAPSHOT_TYPE = "system-prompt-snapshot";
// Sessions written before the generic name was introduced remain readable.
const LEGACY_SYSTEM_PROMPT_SNAPSHOT_TYPE = "agents-snapshot";
const SESSION_TIME_ANCHOR_TYPE = "session-time-anchor";
const MEMORY_BOOTSTRAP_TYPE = "memory-bootstrap";
const SELF_BOOTSTRAP_TYPE = "self-bootstrap";
const SKILL_INVOCATION_TYPE = "skill-invocation";

// CustomMessage.content は string | (TextContent | ImageContent)[] だが、
// このファイルでは常に string のみを書き込むため、テンプレートリテラル展開時に
// [object Object] 化しないよう型上も string に絞る
type SystemPromptSnapshotMessage = Omit<CustomMessage, "content"> & {
  customType: typeof SYSTEM_PROMPT_SNAPSHOT_TYPE;
  content: string;
};
type SessionTimeAnchorMessage = Omit<CustomMessage, "content"> & {
  customType: typeof SESSION_TIME_ANCHOR_TYPE;
  content: string;
};
// MEMORY.md / SELF.md 共通の context-bootstrap メッセージ型（詳細は ContextBootstrapChannel 定義を参照）
type ContextBootstrapMessage = Omit<CustomMessage, "content"> & {
  customType: typeof MEMORY_BOOTSTRAP_TYPE | typeof SELF_BOOTSTRAP_TYPE;
  content: string;
};
type SkillInvocationMessage = Omit<CustomMessage, "content"> & {
  customType: typeof SKILL_INVOCATION_TYPE;
  content: string;
};

// グループ system prompt がない場合のフォールバック。ペルソナはグループ側で
// 上書きされる前提のため、ここには全グループ共通で成り立つ最小限だけを書く。
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful Discord assistant.";

// MEMORY.md / SELF.md をコンテキストに注入する際の文字数上限（同上限。
// SELF.md 側は docs/todo/issue-persona-growth.md のガードレール要件）
const MEMORY_CHAR_LIMIT = 2000;
const SELF_CHAR_LIMIT = 2000;

const CONTEXT_BOOTSTRAP_CHANNELS: ContextBootstrapChannel[] = [
  {
    customType: MEMORY_BOOTSTRAP_TYPE,
    path: "/workspace/MEMORY.md",
    header: "Memory (MEMORY.md)",
    charLimit: MEMORY_CHAR_LIMIT,
  },
  {
    customType: SELF_BOOTSTRAP_TYPE,
    path: "/workspace/memory/SELF.md",
    header: "Persona (SELF.md)",
    charLimit: SELF_CHAR_LIMIT,
  },
];

// VM内で使用不可のツール（ネスト不可・ネイティブバイナリ依存）
const VM_UNSUPPORTED_TOOLS = new Set<string>([]);

// コンテナ起動直後はDNSリゾルバの準備が整っていないことがあるため待機する
const NETWORK_READY_HOST = "r.jina.ai";
const NETWORK_READY_TIMEOUT_MS = 10_000;
const NETWORK_READY_RETRY_MS = 500;
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

/** 外部ホスト名解決ができるまで待機する（最大 timeoutMs、失敗時はそのまま続行） */
export async function waitForNetwork(options?: {
  host?: string;
  timeoutMs?: number;
  retryMs?: number;
  lookupFn?: (host: string) => Promise<unknown>;
  sleepFn?: (ms: number) => Promise<void>;
}): Promise<void> {
  const host = options?.host ?? NETWORK_READY_HOST;
  const timeoutMs = options?.timeoutMs ?? NETWORK_READY_TIMEOUT_MS;
  const retryMs = options?.retryMs ?? NETWORK_READY_RETRY_MS;
  const lookupFn = options?.lookupFn ?? lookup;
  const sleepFn =
    options?.sleepFn ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await lookupFn(host);
      return;
    } catch {
      await sleepFn(retryMs);
    }
  }
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

/** custom メッセージの customType を取り出す。custom role でなければ undefined */
function getCustomType(msg: AgentMessage): string | undefined {
  if (!("role" in msg) || (msg as { role: unknown }).role !== "custom") {
    return undefined;
  }
  if (!("customType" in msg)) return undefined;
  return (msg as { customType: unknown }).customType as string;
}

function isSystemPromptSnapshotMessage(
  msg: AgentMessage,
): msg is SystemPromptSnapshotMessage {
  const customType = getCustomType(msg);
  return (
    customType === SYSTEM_PROMPT_SNAPSHOT_TYPE ||
    customType === LEGACY_SYSTEM_PROMPT_SNAPSHOT_TYPE
  );
}

function isSessionTimeAnchorMessage(
  msg: AgentMessage,
): msg is SessionTimeAnchorMessage {
  return getCustomType(msg) === SESSION_TIME_ANCHOR_TYPE;
}

function isSkillInvocationMessage(
  msg: AgentMessage,
): msg is SkillInvocationMessage {
  return getCustomType(msg) === SKILL_INVOCATION_TYPE;
}

// MEMORY.md / SELF.md は「ワークスペース上のファイルをセッション初回に一度だけ
// 擬似ユーザーメッセージとして注入する」という同一の仕組みを共有する（context-bootstrap
// チャンネル）。差分は customType・読み込みパス・見出し・文字数上限のみなので、
// ここに定義を1箇所へ集約し、runAgentLoop / defaultConvertToLlm 側はこの配列を走査するだけにする。
type ContextBootstrapChannel = {
  customType: typeof MEMORY_BOOTSTRAP_TYPE | typeof SELF_BOOTSTRAP_TYPE;
  path: string;
  header: string;
  charLimit: number;
};

/** カスタムプロバイダーの API キーを credential-proxy + 環境変数から取得 */
async function getCustomProviderApiKey(
  provider: string,
): Promise<string | undefined> {
  try {
    const entries = await loadCredentialProxy();
    const entry = entries.find((e) => e.provider === provider);
    if (!entry) return undefined;
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

/** ワークスペース上のファイルを読む。存在しなければ null（他のエラーは再送出） */
async function loadWorkspaceFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
function snapshotHash(content: string | null): string | undefined {
  return content === null
    ? undefined
    : createHash("sha256").update(content).digest("hex");
}

function findEarliestMessageTimestamp(
  messages: AgentMessage[],
): number | undefined {
  let earliest: number | undefined;
  for (const message of messages) {
    const timestamp = message.timestamp;
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) continue;
    if (earliest === undefined || timestamp < earliest) earliest = timestamp;
  }
  return earliest;
}

const HOUR_MS = 60 * 60 * 1000;
const MIN_TIME_ANCHOR_MS = 946_684_800_000;

function canonicalHour(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

function parseSessionTimeAnchor(message: SessionTimeAnchorMessage): number {
  const serialized = message.content.trim();
  const timestamp = Number(serialized);
  if (
    String(timestamp) !== serialized ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < MIN_TIME_ANCHOR_MS ||
    !Number.isFinite(new Date(timestamp).getTime())
  ) {
    throw new Error("セッション時刻アンカーが不正です");
  }
  return canonicalHour(timestamp);
}

async function loadOrCreateSessionTimeAnchor(
  groupName: string,
  sessionId: string,
  messages: AgentMessage[],
  fallbackTimestamp: () => number,
): Promise<number> {
  const existing = messages.find(isSessionTimeAnchorMessage);
  if (existing) return parseSessionTimeAnchor(existing);

  const fallback = fallbackTimestamp();
  const candidate = canonicalHour(
    Number.isSafeInteger(fallback) &&
      fallback >= MIN_TIME_ANCHOR_MS &&
      Number.isFinite(new Date(fallback).getTime())
      ? fallback
      : Date.now(),
  );
  const anchorMessage: SessionTimeAnchorMessage = {
    role: "custom",
    customType: SESSION_TIME_ANCHOR_TYPE,
    content: `${candidate}`,
    display: false,
    timestamp: candidate,
  };
  await appendMessage(groupName, sessionId, anchorMessage);
  return candidate;
}

function formatBootstrapSection(
  channel: ContextBootstrapChannel,
  content: string,
): string {
  const codePoints = Array.from(content);
  if (codePoints.length <= channel.charLimit) {
    return `## ${channel.header}\n\n${content}`;
  }

  const truncated = codePoints.slice(0, channel.charLimit).join("");
  return `## ${channel.header}\n\n${truncated}\n\n[Warning: ${channel.header} exceeds the limit (${channel.charLimit} characters). Delete or summarize old content to keep it organized]`;
}

const CONTEXT_BOOTSTRAP_TYPES = new Set(
  CONTEXT_BOOTSTRAP_CHANNELS.map((c) => c.customType as string),
);

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
  return messages.flatMap((msg) => {
    if (isSystemPromptSnapshotMessage(msg) || isSessionTimeAnchorMessage(msg))
      return [];
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

export interface FrozenExecutionIdentity {
  systemPromptSnapshotContent?: string;
  memorySnapshotContent?: string;
  systemPromptSnapshotPresent?: boolean;
  memorySnapshotPresent?: boolean;
  snapshotHash?: string;
  toolCallKey?: string;
}
export async function runAgentLoop(
  groupName: string,
  sessionId: string,
  content: string,
  groupConfig: AgentRuntimeConfig,
  identity?: FrozenExecutionIdentity,
  systemPromptAppend?: string,
  botToolEndpoint?: BotToolEndpoint,
  onAgentCreated?: (agent: Agent) => void,
  signal?: AbortSignal,
): Promise<string> {
  const rawMessages = await loadMessages(groupName, sessionId);
  const sessionAnchorTimestamp = await loadOrCreateSessionTimeAnchor(
    groupName,
    sessionId,
    rawMessages,
    () => findEarliestMessageTimestamp(rawMessages) ?? Date.now(),
  );
  const sessionTimeAnchorContent = formatSessionTimeAnchor(
    sessionAnchorTimestamp,
  );

  // stopReason が error/aborted のメッセージはデバッグ用にセッションに残すが
  // LLM コンテキストには含めない（空の assistant ターンとして混入するのを防ぐ）
  let messages = rawMessages.filter((m) => {
    if (!isAssistantMessage(m)) return true;
    return m.stopReason !== "error" && m.stopReason !== "aborted";
  });

  // bootstrap 系（system-prompt-snapshot / context-bootstrap＝memory-bootstrap・self-bootstrap）は
  // 常に先頭に並べる。旧形式セッションの移行では appendMessage で JSONL 末尾に追記されるため、
  // ロード後に並べ替えないと、移行ターンと次ターン以降で bootstrap の位置が変わり、
  // LLM への見え方が非対称になる上にプロンプトキャッシュも効かなくなる。
  const isBootstrapMessage = (m: AgentMessage) =>
    isSystemPromptSnapshotMessage(m) ||
    CONTEXT_BOOTSTRAP_TYPES.has(getCustomType(m) ?? "");
  messages = [
    ...messages.filter(isBootstrapMessage),
    ...messages.filter((m) => !isBootstrapMessage(m)),
  ];

  // 既存セッションに system prompt のスナップショットがあれば再読み込みせず再利用する
  // （system role のまま固定し、ファイル更新の影響を受けないようにする）。
  // 新規セッション（messages が空）では必然的に見つからず needsSystemPromptSnapshot は true になる
  const existingSystemPromptSnapshot = messages.find(
    isSystemPromptSnapshotMessage,
  );
  const needsSystemPromptSnapshot = !existingSystemPromptSnapshot;
  const channelsNeedingBootstrap = CONTEXT_BOOTSTRAP_CHANNELS.filter(
    (channel) => !messages.some((m) => getCustomType(m) === channel.customType),
  );

  const [loadedSystemPrompt, skills, channelFileContents] = await Promise.all([
    identity?.systemPromptSnapshotPresent !== undefined
      ? Promise.resolve(
          identity.systemPromptSnapshotPresent
            ? (identity.systemPromptSnapshotContent ?? "")
            : null,
        )
      : needsSystemPromptSnapshot
        ? (identity?.systemPromptSnapshotContent ??
          (await loadGroupSystemPrompt()))
        : Promise.resolve(null),
    loadSkills("/workspace/SKILLS", groupConfig.skills),
    Promise.all(
      channelsNeedingBootstrap.map((c) =>
        c.customType === MEMORY_BOOTSTRAP_TYPE &&
        identity?.memorySnapshotPresent !== undefined
          ? Promise.resolve(
              identity.memorySnapshotPresent
                ? (identity.memorySnapshotContent ?? "")
                : null,
            )
          : c.customType === MEMORY_BOOTSTRAP_TYPE &&
              identity?.memorySnapshotContent !== undefined
            ? Promise.resolve(identity.memorySnapshotContent)
            : loadWorkspaceFile(c.path),
      ),
    ),
  ]);

  // `./command スキル名` 形式のメッセージは、LLMの自律判断を待たずに
  // 指定スキルのSKILL.md本文をそのままプロンプトへ強制注入して実行させる。
  // ユーザーの生発言は content のまま user メッセージとして残し、
  // 注入指示は別の skill-invocation custom メッセージに分離する
  // （JSONL履歴上で「何を打ったか」と「LLMに渡った指示」を区別できるようにするため）。
  let promptInput: string | AgentMessage[] = content;
  const skillCommand = parseSkillCommand(content);
  if (skillCommand) {
    const skill = skills.find((s) => s.name === skillCommand.skillName);
    if (!skill) {
      const available = skills.map((s) => s.name).join(", ") || "(なし)";
      return `❌ スキル "${skillCommand.skillName}" が見つかりません。利用可能なスキル: ${available}`;
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

  const model = await resolveModel(
    groupConfig.model?.provider ?? FALLBACK_DEFAULT_MODEL.provider,
    groupConfig.model?.modelId ?? FALLBACK_DEFAULT_MODEL.modelId,
  );

  const skillPrompt = formatSkillsForPrompt(skills);

  const systemPromptSnapshotHash = snapshotHash(
    identity?.systemPromptSnapshotPresent !== undefined
      ? identity.systemPromptSnapshotPresent
        ? (identity.systemPromptSnapshotContent ?? "")
        : null
      : (identity?.systemPromptSnapshotContent ??
          (needsSystemPromptSnapshot
            ? loadedSystemPrompt
            : (existingSystemPromptSnapshot?.content ?? null))),
  );
  const existingMemorySnapshot = messages.find(
    (message) => getCustomType(message) === MEMORY_BOOTSTRAP_TYPE,
  );
  const memoryBootstrapIndex = channelsNeedingBootstrap.findIndex(
    (channel) => channel.customType === MEMORY_BOOTSTRAP_TYPE,
  );
  const memoryContent =
    identity?.memorySnapshotPresent !== undefined
      ? identity.memorySnapshotPresent
        ? (identity.memorySnapshotContent ?? "")
        : null
      : (identity?.memorySnapshotContent ??
        (existingMemorySnapshot && "content" in existingMemorySnapshot
          ? String(existingMemorySnapshot.content)
          : memoryBootstrapIndex >= 0
            ? (channelFileContents[memoryBootstrapIndex] ?? null)
            : null));
  const memorySnapshotHash = snapshotHash(memoryContent);
  const computedSnapshotHash =
    systemPromptSnapshotHash === undefined && memorySnapshotHash === undefined
      ? undefined
      : createHash("sha256")
          .update(
            `${systemPromptSnapshotHash ?? ""}:${memorySnapshotHash ?? ""}`,
          )
          .digest("hex");
  const snapshotHashValue = identity?.snapshotHash ?? computedSnapshotHash;
  const toolCallKey =
    identity?.toolCallKey ??
    (snapshotHashValue
      ? createHash("sha256")
          .update(`${groupName}:${sessionId}:${content}:${snapshotHashValue}`)
          .digest("hex")
      : undefined);

  // system prompt の内容: 新規読み込み分があればそれを、なければ既存スナップショットを使う。
  // system role の systemPrompt に固定で含める（指示遵守の優先度を維持するため）。
  // グループの system prompt が存在する場合は DEFAULT_SYSTEM_PROMPT を完全に置き換える
  // （グループ独自のペルソナ定義と汎用文言が矛盾しないようにするため）。
  //
  // 【仕様】system prompt が空文字（ファイルは存在するが中身が空）の場合、
  // `systemPromptContent ?? DEFAULT_SYSTEM_PROMPT` は "" のままとなり、続く .filter(Boolean) で
  // 除外される。結果として DEFAULT_SYSTEM_PROMPT も含まれず、systemPrompt は skills+date のみになる。
  // これは意図的な挙動: 「空の system prompt」を置くことを、グループがベースプロンプトを
  // 明示的にオプトアウトする手段として扱う（ファイル不存在=null の場合のみ DEFAULT を適用する）。
  //
  // MEMORY.md / SELF.md は下の context-bootstrap 注入によって会話履歴経由で LLM に届く
  // （user role に変換されるため、system prompt と二重注入にはならない）。
  const systemPromptContent =
    identity?.systemPromptSnapshotPresent !== undefined
      ? identity.systemPromptSnapshotPresent
        ? (identity.systemPromptSnapshotContent ?? "")
        : null
      : (identity?.systemPromptSnapshotContent ??
        (needsSystemPromptSnapshot
          ? loadedSystemPrompt
          : (existingSystemPromptSnapshot?.content ?? null)));
  const fullSystemPrompt = [
    systemPromptContent ?? DEFAULT_SYSTEM_PROMPT,
    sessionTimeAnchorContent,
    skillPrompt,
    systemPromptAppend,
  ]
    .filter(Boolean)
    .join("\n\n");

  const newBootstrapMessages: AgentMessage[] = [];

  // 新規セッション、またはスナップショット未作成の既存セッションの場合、
  // system prompt をセッションに固定化するスナップショットを書き込む。
  // system prompt が空文字でも「ファイルは存在し空である」という状態を固定化するため、
  // null（値不存在）とは区別して書き込む（そうしないと毎ターン再読み込みし続ける）
  if (needsSystemPromptSnapshot && loadedSystemPrompt !== null) {
    const systemPromptSnapshotMessage: SystemPromptSnapshotMessage = {
      role: "custom",
      customType: SYSTEM_PROMPT_SNAPSHOT_TYPE,
      content: loadedSystemPrompt,
      display: false,
      timestamp: Date.now(),
    };
    await appendMessage(groupName, sessionId, systemPromptSnapshotMessage);
    newBootstrapMessages.push(systemPromptSnapshotMessage);
  }

  // 新規セッション、または旧形式セッション（次回以降は新方式に移行させる）の場合、
  // MEMORY.md / SELF.md を custom メッセージとして注入する。
  // 各ファイルが空文字でも「ファイルは存在し空である」という状態を固定化するため、
  // null（値不存在）とは区別して書き込む（system prompt と同様、そうしないと毎ターン再読み込みし続ける）
  for (const [i, channel] of channelsNeedingBootstrap.entries()) {
    const fileContent = channelFileContents[i];
    if (fileContent === null) continue;
    const bootstrapMessage: ContextBootstrapMessage = {
      role: "custom",
      customType: channel.customType,
      content: formatBootstrapSection(channel, fileContent),
      display: false,
      timestamp: Date.now(),
    };
    await appendMessage(groupName, sessionId, bootstrapMessage);
    newBootstrapMessages.push(bootstrapMessage);
  }

  // newBootstrapMessages を先頭へ丸ごと prepend すると、移行ターン（例: memory-bootstrap は
  // 既存であり self-bootstrap のみ新規追加される場合）で self-bootstrap が memory-bootstrap より
  // 前に来てしまい、次ターン以降（JSONL 再ロード時は定義順に並ぶ）と順序が食い違う。
  // bootstrap 種別の正規順序（system-prompt-snapshot → CONTEXT_BOOTSTRAP_CHANNELS の定義順）でマージし、
  // 移行ターンでも安定した順序を保つ。
  if (newBootstrapMessages.length > 0) {
    const bootstrapOrder = [
      SYSTEM_PROMPT_SNAPSHOT_TYPE as string,
      ...CONTEXT_BOOTSTRAP_CHANNELS.map((c) => c.customType as string),
    ];
    const orderIndex = (m: AgentMessage) =>
      bootstrapOrder.indexOf(getCustomType(m) ?? "");
    const boundary = messages.findIndex((m) => !isBootstrapMessage(m));
    const existingBootstrapCount = boundary === -1 ? messages.length : boundary;
    const mergedBootstraps = [
      ...messages.slice(0, existingBootstrapCount),
      ...newBootstrapMessages,
    ].sort((a, b) => orderIndex(a) - orderIndex(b));
    messages = [...mergedBootstraps, ...messages.slice(existingBootstrapCount)];
  }

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
  const agentTools = resolveTools(groupConfig.tools ?? [], {
    subagent: () =>
      groupConfig.tools?.includes("subagent") === true
        ? createSubagentTool(delegationContext)
        : undefined,
    bot: () =>
      botToolEndpoint && groupConfig.tools?.includes("bot") === true
        ? createBotTool({
            endpoint: botToolEndpoint,
            groupName,
            onUsage: (usage) => {
              aggregatedUsage = addTokenUsage(aggregatedUsage, usage);
              hasUsage = true;
            },
          })
        : undefined,
  }).filter((t) => !VM_UNSUPPORTED_TOOLS.has(t.name));
  delegationContext.tools = agentTools;

  const pendingAppends: Promise<void>[] = [];
  let response = "";
  let assistantTurns = 0;
  let aggregatedUsage: AgentTokenUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  let hasUsage = false;
  let stopReason: string | undefined;

  // runAgent owns Agent construction and prompt execution. This callback keeps
  // persistent-session concerns (append and Discord event formatting) here.
  const promptStartedAt = Date.now();
  try {
    const execution = await runAgent({
      systemPrompt: fullSystemPrompt,
      model,
      messages,
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
          pendingAppends.push(
            appendMessage(groupName, sessionId, event.message),
          );
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
  }
  await Promise.all(pendingAppends);
  return response;
}

const PayloadSchema = z.object({
  groupName: z.string(),
  sessionId: z.string(),
  content: z.string(),
  groupConfig: AgentRuntimeConfigSchema,
  systemPromptSnapshotContent: z.string().optional(),
  systemPromptSnapshotPresent: z.boolean().optional(),
  memorySnapshotPresent: z.boolean().optional(),
  memorySnapshotContent: z.string().optional(),
  snapshotHash: z.string().optional(),
  toolCallKey: z.string().optional(),
  systemPromptAppend: z.string().optional(),
  botToolEndpoint: z
    .object({ url: z.string().url(), token: z.string().min(1) })
    .optional(),
});

// CLIエントリポイント（import時は実行しない）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    await waitForNetwork();
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
      await appendMessage(groupName, sessionId, message);
      const loaded = await loadMessages(groupName, sessionId);
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

    let response: string;
    try {
      response = await runAgentLoop(
        payload.groupName,
        payload.sessionId,
        payload.content,
        payload.groupConfig,
        payload,
        payload.systemPromptAppend,
        payload.botToolEndpoint,
        (agent) => {
          steering.attach(agent);
          process.stderr.write("__AGENT_ACTIVE__\n");
        },
        abortController.signal,
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
