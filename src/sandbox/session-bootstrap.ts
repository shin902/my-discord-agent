import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  AgentMessage,
  CustomMessage,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { appendMessage } from "../agent/session.js";
import type { AgentRuntimeConfig } from "../config/groups.js";
import { loadSkills } from "../skills/loader.js";
import { formatSkillsForPrompt } from "../skills/prompt.js";
import { formatSessionTimeAnchor } from "../time/context.js";
import { loadGroupSystemPrompt } from "./system-prompt.js";

// pi-agent-core が標準提供する CustomMessage（role: "custom"）を customType で使い分ける:
// - "system-prompt-snapshot": グループの system prompt をセッション初回に固定化するためのスナップショット。
//   役割上は system 相当として扱うため、LLM へのチャット履歴には乗せず systemPrompt の組み立てにのみ使う。
// - "context-bootstrap": AgentConfig.contextFiles をセッション初回に注入する擬似ユーザーメッセージ。
// - "memory-bootstrap" / "self-bootstrap": 旧sessionを読み続けるためのlegacy type。
// - "skill-invocation": `./command` で明示実行されたスキルの SKILL.md 本文を注入する擬似ユーザーメッセージ。
//   ユーザーの生発言（`./command スキル名 ...`）とは別メッセージとして保存することで、
//   session trajectory上でも「ユーザーが何を打ったか」と「LLMに渡った指示内容」を区別できるようにする。
//
// display フラグについて: 標準 CustomMessage の必須フィールドで、pi-coding-agent 系 TUI が
// チャット表示の可否判定に使う。LLM 送信可否（defaultConvertToLlm 側で制御）とは別概念。
// うちはその TUI を使わないため実質無効だが、いずれも裏方メッセージなので意味的に false 固定。
const SYSTEM_PROMPT_SNAPSHOT_TYPE = "system-prompt-snapshot";
// Sessions written before the generic name was introduced remain readable.
const LEGACY_SYSTEM_PROMPT_SNAPSHOT_TYPE = "agents-snapshot";
const SESSION_TIME_ANCHOR_TYPE = "session-time-anchor";
const CONTEXT_BOOTSTRAP_TYPE = "context-bootstrap";
const MEMORY_BOOTSTRAP_TYPE = "memory-bootstrap";
const SELF_BOOTSTRAP_TYPE = "self-bootstrap";

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
export type ContextBootstrapMessage = Omit<CustomMessage, "content"> & {
  customType:
    | typeof CONTEXT_BOOTSTRAP_TYPE
    | typeof MEMORY_BOOTSTRAP_TYPE
    | typeof SELF_BOOTSTRAP_TYPE;
  content: string;
};

// グループ system prompt がない場合のフォールバック。ペルソナはグループ側で
// 上書きされる前提のため、ここには全グループ共通で成り立つ最小限だけを書く。
export const DEFAULT_SYSTEM_PROMPT = "You are a helpful Discord assistant.";

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "role" in msg &&
    (msg as Record<string, unknown>).role === "assistant"
  );
}

/** custom メッセージの customType を取り出す。custom role でなければ undefined */
export function getCustomType(msg: AgentMessage): string | undefined {
  if (!("role" in msg) || (msg as { role: unknown }).role !== "custom") {
    return undefined;
  }
  if (!("customType" in msg)) return undefined;
  return (msg as { customType: unknown }).customType as string;
}

export function isSystemPromptSnapshotMessage(
  msg: AgentMessage,
): msg is SystemPromptSnapshotMessage {
  const customType = getCustomType(msg);
  return (
    customType === SYSTEM_PROMPT_SNAPSHOT_TYPE ||
    customType === LEGACY_SYSTEM_PROMPT_SNAPSHOT_TYPE
  );
}

export function isSessionTimeAnchorMessage(
  msg: AgentMessage,
): msg is SessionTimeAnchorMessage {
  return getCustomType(msg) === SESSION_TIME_ANCHOR_TYPE;
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
  agentId: string,
): Promise<number> {
  const existing = messages.find(isSessionTimeAnchorMessage);
  if (existing) return parseSessionTimeAnchor(existing);

  const candidate = canonicalHour(Date.now());
  const anchorMessage: SessionTimeAnchorMessage = {
    role: "custom",
    customType: SESSION_TIME_ANCHOR_TYPE,
    content: `${candidate}`,
    display: false,
    timestamp: candidate,
  };
  await appendMessage(groupName, sessionId, anchorMessage, agentId);
  return candidate;
}

function formatBootstrapSection(
  file: NonNullable<AgentRuntimeConfig["contextFiles"]>[number],
  content: string,
): string {
  const codePoints = Array.from(content);
  if (file.maxChars === "*" || codePoints.length <= file.maxChars) {
    return `## Context (${file.path})\n\n${content}`;
  }

  const truncated = codePoints.slice(0, file.maxChars).join("");
  return `## Context (${file.path})\n\n${truncated}\n\n[Warning: Context (${file.path}) exceeds the limit (${file.maxChars} characters)]`;
}

export const CONTEXT_BOOTSTRAP_TYPES = new Set([
  CONTEXT_BOOTSTRAP_TYPE,
  MEMORY_BOOTSTRAP_TYPE,
  SELF_BOOTSTRAP_TYPE,
]);

export interface FrozenExecutionIdentity {
  systemPromptSnapshotContent?: string;
  memorySnapshotContent?: string;
  systemPromptSnapshotPresent?: boolean;
  memorySnapshotPresent?: boolean;
  snapshotHash?: string;
  toolCallKey?: string;
  agentId: string;
}
export async function initializeSessionBootstrap(
  groupName: string,
  sessionId: string,
  rawMessages: AgentMessage[],
  groupConfig: AgentRuntimeConfig,
  identity: FrozenExecutionIdentity,
) {
  const sessionAnchorTimestamp = await loadOrCreateSessionTimeAnchor(
    groupName,
    sessionId,
    rawMessages,
    identity.agentId,
  );

  // stopReason が error/aborted のメッセージはデバッグ用にセッションに残すが
  // LLM コンテキストには含めない（空の assistant ターンとして混入するのを防ぐ）
  let messages = rawMessages.filter((m) => {
    if (!isAssistantMessage(m)) return true;
    return m.stopReason !== "error" && m.stopReason !== "aborted";
  });

  // bootstrap 系（system-prompt-snapshot / context-bootstrap / legacy bootstrap）は
  // 常に先頭に並べる。保存済みentryの途中に追加された bootstrap をロード後に
  // 並べ替え、現在のターンと次回ロード時の LLM-visible ordering を安定させる。
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
  const needsContextBootstrap = !rawMessages.some(
    (message) =>
      message.role === "assistant" ||
      message.role === "toolResult" ||
      CONTEXT_BOOTSTRAP_TYPES.has(getCustomType(message) ?? ""),
  );
  const contextFiles = groupConfig.contextFiles ?? [];

  const [loadedSystemPrompt, skills, contextFileContents] = await Promise.all([
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
    needsContextBootstrap
      ? Promise.all(
          contextFiles.map((file) =>
            loadWorkspaceFile(`/workspace/${file.path}`),
          ),
        )
      : Promise.resolve([]),
  ]);

  const newBootstrapMessages: AgentMessage[] = [];

  if (needsSystemPromptSnapshot && loadedSystemPrompt !== null) {
    const systemPromptSnapshotMessage: SystemPromptSnapshotMessage = {
      role: "custom",
      customType: SYSTEM_PROMPT_SNAPSHOT_TYPE,
      content: loadedSystemPrompt,
      display: false,
      timestamp: Date.now(),
    };
    await appendMessage(
      groupName,
      sessionId,
      systemPromptSnapshotMessage,
      identity.agentId,
    );
    newBootstrapMessages.push(systemPromptSnapshotMessage);
  }

  if (needsContextBootstrap) {
    const sections = contextFiles.flatMap((file, index) => {
      const fileContent = contextFileContents[index];
      return fileContent === null
        ? []
        : [formatBootstrapSection(file, fileContent)];
    });
    if (sections.length > 0) {
      const bootstrapMessage: ContextBootstrapMessage = {
        role: "custom",
        customType: CONTEXT_BOOTSTRAP_TYPE,
        content: sections.join("\n\n"),
        display: false,
        timestamp: Date.now(),
      };
      await appendMessage(
        groupName,
        sessionId,
        bootstrapMessage,
        identity.agentId,
      );
      newBootstrapMessages.push(bootstrapMessage);
    }
  }

  if (newBootstrapMessages.length > 0) {
    const bootstrapOrder = [
      SYSTEM_PROMPT_SNAPSHOT_TYPE as string,
      MEMORY_BOOTSTRAP_TYPE,
      SELF_BOOTSTRAP_TYPE,
      CONTEXT_BOOTSTRAP_TYPE,
    ];
    const orderIndex = (message: AgentMessage) =>
      bootstrapOrder.indexOf(getCustomType(message) ?? "");
    const boundary = messages.findIndex(
      (message) => !isBootstrapMessage(message),
    );
    const existingBootstrapCount = boundary === -1 ? messages.length : boundary;
    const mergedBootstraps = [
      ...messages.slice(0, existingBootstrapCount),
      ...newBootstrapMessages,
    ].sort((a, b) => orderIndex(a) - orderIndex(b));
    messages = [...mergedBootstraps, ...messages.slice(existingBootstrapCount)];
  }

  return {
    messages,
    skills,
    sessionAnchorTimestamp,
    needsSystemPromptSnapshot,
    loadedSystemPrompt,
    existingSystemPromptSnapshot,
  };
}

export function buildBootstrapSystemPrompt(
  groupName: string,
  sessionId: string,
  content: string,
  groupConfig: AgentRuntimeConfig,
  identity: FrozenExecutionIdentity | undefined,
  systemPromptAppend: string | undefined,
  bootstrap: Awaited<ReturnType<typeof initializeSessionBootstrap>>,
) {
  const {
    messages,
    skills,
    sessionAnchorTimestamp,
    needsSystemPromptSnapshot,
    loadedSystemPrompt,
    existingSystemPromptSnapshot,
  } = bootstrap;
  const sessionTimeAnchorContent = formatSessionTimeAnchor(
    sessionAnchorTimestamp,
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
  const memoryContent =
    identity?.memorySnapshotPresent === true
      ? (identity.memorySnapshotContent ?? "")
      : existingMemorySnapshot && "content" in existingMemorySnapshot
        ? String(existingMemorySnapshot.content)
        : null;
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
  // contextFiles は下の context-bootstrap 注入によって会話履歴経由で LLM に届く
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
  const mounts = groupConfig.mounts ?? [];
  const mountPrompt = mounts.length
    ? [
        "Additional mounted paths:",
        ...mounts.map(
          ({ container, readOnly }) =>
            `- ${JSON.stringify(container)} (${readOnly ? "ro" : "rw"})`,
        ),
        "When the requested work concerns an existing mounted path, use that mount directly.",
        "Use an existing mounted path directly when possible.",
      ].join("\n")
    : undefined;
  const fullSystemPrompt = [
    systemPromptContent ?? DEFAULT_SYSTEM_PROMPT,
    sessionTimeAnchorContent,
    skillPrompt,
    mountPrompt,
    systemPromptAppend,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    fullSystemPrompt,
    snapshotHashValue,
    toolCallKey,
    systemPromptSnapshotHash,
    memorySnapshotHash,
  };
}
