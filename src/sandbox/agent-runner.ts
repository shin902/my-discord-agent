import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import {
  Agent,
  type AgentMessage,
  convertToLlm as libraryConvertToLlm,
  type CustomMessage,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  getEnvApiKey,
  type Message,
  type TextContent,
} from "@earendil-works/pi-ai";
import { z } from "zod";

import { resolveModel } from "../agent/model.js";
import { appendMessage, loadMessages } from "../agent/session.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import { FALLBACK_DEFAULT_MODEL } from "../config/default-model.js";
import { type AgentConfig, AgentConfigSchema } from "../config/groups.js";
import { loadSkills } from "../skills/loader.js";
import { formatSkillsForPrompt } from "../skills/prompt.js";
import { resolveTools } from "../tools/registry.js";
import { isTransientError } from "../utils/error.js";

// pi-agent-core が標準提供する CustomMessage（role: "custom"）を customType で使い分ける:
// - "agents-snapshot": AGENTS.md の内容をセッション初回に固定化するためのスナップショット。
//   役割上は system 相当として扱うため、LLM へのチャット履歴には乗せず systemPrompt の組み立てにのみ使う。
// - "memory-bootstrap": MEMORY.md をセッション初回に注入する擬似ユーザーメッセージ。
const AGENTS_SNAPSHOT_TYPE = "agents-snapshot";
const MEMORY_BOOTSTRAP_TYPE = "memory-bootstrap";

type AgentsSnapshotMessage = CustomMessage & {
  customType: typeof AGENTS_SNAPSHOT_TYPE;
};
type MemoryBootstrapMessage = CustomMessage & {
  customType: typeof MEMORY_BOOTSTRAP_TYPE;
};

const DEFAULT_SYSTEM_PROMPT = "あなたは役立つDiscordアシスタントです。";

// MEMORY.md をコンテキストに注入する際の文字数上限
const MEMORY_CHAR_LIMIT = 2000;

// VM内で使用不可のツール（ネスト不可・ネイティブバイナリ依存）
const VM_UNSUPPORTED_TOOLS = new Set<string>([]);

// コンテナ起動直後はDNSリゾルバの準備が整っていないことがあるため待機する
const NETWORK_READY_HOST = "r.jina.ai";
const NETWORK_READY_TIMEOUT_MS = 10_000;
const NETWORK_READY_RETRY_MS = 500;

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

function isAgentsSnapshotMessage(
  msg: AgentMessage,
): msg is AgentsSnapshotMessage {
  return (
    "role" in msg &&
    (msg as { role: unknown }).role === "custom" &&
    "customType" in msg &&
    (msg as { customType: unknown }).customType === AGENTS_SNAPSHOT_TYPE
  );
}

function isMemoryBootstrapMessage(
  msg: AgentMessage,
): msg is MemoryBootstrapMessage {
  return (
    "role" in msg &&
    (msg as { role: unknown }).role === "custom" &&
    "customType" in msg &&
    (msg as { customType: unknown }).customType === MEMORY_BOOTSTRAP_TYPE
  );
}

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

async function loadSystemPromptFromWorkspace(): Promise<string | null> {
  try {
    return await readFile("/workspace/AGENTS.md", "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function loadMemoryFromWorkspace(): Promise<string | null> {
  try {
    return await readFile("/workspace/MEMORY.md", "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function formatDateForPrompt(): string {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Tokyo",
  });
  return `## 今日の日付\n\n${today} (JST)`;
}

function formatMemoryForPrompt(memory: string | null): string {
  if (!memory) return "";

  const codePoints = Array.from(memory);
  if (codePoints.length <= MEMORY_CHAR_LIMIT) {
    return `## 記憶 (MEMORY.md)\n\n${memory}`;
  }

  const truncated = codePoints.slice(0, MEMORY_CHAR_LIMIT).join("");
  return `## 記憶 (MEMORY.md)\n\n${truncated}\n\n[警告: MEMORY.md が上限(${MEMORY_CHAR_LIMIT}字)を超えています。古いセクションを削除・要約して整理してください]`;
}

/** AgentMessage[] を LLM 送信用 Message[] に変換する。
 * - agentsSnapshot: systemPrompt の組み立てにのみ使うため、チャット履歴からは常に除外する。
 * - memoryBootstrap: 最初の1件のみ user として展開し、残りは除外する
 *   （セッションあたり1件しか書き込まれないため、実質的にフィルタが発動するケースはない）。
 * - それ以外（bashExecution・branchSummary・compactionSummary・他の customType 等）は
 *   pi-agent-core 標準の convertToLlm に委譲する。未知の role を無効なまま LLM へ渡さないため。 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  let memoryBootstrapSeen = false;
  return messages.flatMap((msg) => {
    if (isAgentsSnapshotMessage(msg)) return [];
    if (isMemoryBootstrapMessage(msg)) {
      if (memoryBootstrapSeen) return [];
      memoryBootstrapSeen = true;
      return [{ role: "user", content: msg.content, timestamp: msg.timestamp }];
    }
    return libraryConvertToLlm([msg]);
  });
}

export async function runAgentLoop(
  groupName: string,
  sessionId: string,
  content: string,
  groupConfig: AgentConfig,
): Promise<string> {
  const rawMessages = await loadMessages(groupName, sessionId);

  // stopReason が error/aborted のメッセージはデバッグ用にセッションに残すが
  // LLM コンテキストには含めない（空の assistant ターンとして混入するのを防ぐ）
  let messages = rawMessages.filter((m) => {
    if (!isAssistantMessage(m)) return true;
    return m.stopReason !== "error" && m.stopReason !== "aborted";
  });

  // AGENTS.md: 既存セッションにスナップショットがあれば再読み込みせず再利用する
  // （system role のまま固定し、ファイル更新の影響を受けないようにする）。
  // 新規セッション（messages が空）では必然的に見つからず needsAgentsSnapshot は true になる
  const existingAgentsSnapshot = messages.find(isAgentsSnapshotMessage);
  const needsAgentsSnapshot = !existingAgentsSnapshot;

  // MEMORY.md: 既存セッションに bootstrap メッセージがあれば新方式セッションとみなす。
  // フォールバック: bootstrap がない既存セッション（旧形式）は次回以降のため移行する。
  // 新規セッションでは必然的に false になり needsMemoryBootstrap は true になる
  const hasMemoryBootstrap = messages.some(isMemoryBootstrapMessage);
  const needsMemoryBootstrap = !hasMemoryBootstrap;

  const [systemPromptFile, skills, memory] = await Promise.all([
    needsAgentsSnapshot
      ? loadSystemPromptFromWorkspace()
      : Promise.resolve(null),
    loadSkills("/workspace/SKILLS", groupConfig.skills),
    needsMemoryBootstrap ? loadMemoryFromWorkspace() : Promise.resolve(null),
  ]);

  const model = await resolveModel(
    groupConfig.model?.provider ?? FALLBACK_DEFAULT_MODEL.provider,
    groupConfig.model?.modelId ?? FALLBACK_DEFAULT_MODEL.modelId,
  );

  const tools = resolveTools(groupConfig.tools ?? []).filter(
    (t) => !VM_UNSUPPORTED_TOOLS.has(t.name),
  );

  const skillPrompt = formatSkillsForPrompt(skills);
  const datePrompt = formatDateForPrompt();

  // AGENTS.md の内容: 新規読み込み分があればそれを、なければ既存スナップショットを使う
  const agentsContent = needsAgentsSnapshot
    ? systemPromptFile
    : (existingAgentsSnapshot?.content ?? null);
  const agentsSection = agentsContent
    ? `## エージェント設定 (AGENTS.md)\n\n${agentsContent}`
    : "";

  // AGENTS.md は system role の systemPrompt に固定で含める（指示遵守の優先度を維持するため）。
  // MEMORY.md は下の memoryBootstrap 注入によって会話履歴経由で LLM に届く
  // （user role に変換されるため、AGENTS.md と二重注入にはならない）。
  const fullSystemPrompt = [
    DEFAULT_SYSTEM_PROMPT,
    agentsSection,
    skillPrompt,
    datePrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  const newBootstrapMessages: AgentMessage[] = [];

  // 新規セッション、またはスナップショット未作成の既存セッションの場合、
  // AGENTS.md をセッションに固定化するスナップショットを書き込む
  if (needsAgentsSnapshot && systemPromptFile) {
    const agentsSnapshotMessage: AgentsSnapshotMessage = {
      role: "custom",
      customType: AGENTS_SNAPSHOT_TYPE,
      content: systemPromptFile,
      display: false,
      timestamp: Date.now(),
    };
    await appendMessage(
      groupName,
      sessionId,
      agentsSnapshotMessage as AgentMessage,
    );
    newBootstrapMessages.push(agentsSnapshotMessage as AgentMessage);
  }

  // 新規セッション、または旧形式セッション（次回以降は新方式に移行させる）の場合、
  // MEMORY.md を custom メッセージとして注入する
  if (needsMemoryBootstrap && memory) {
    const memoryBootstrapMessage: MemoryBootstrapMessage = {
      role: "custom",
      customType: MEMORY_BOOTSTRAP_TYPE,
      content: formatMemoryForPrompt(memory),
      display: false,
      timestamp: Date.now(),
    };
    await appendMessage(
      groupName,
      sessionId,
      memoryBootstrapMessage as AgentMessage,
    );
    newBootstrapMessages.push(memoryBootstrapMessage as AgentMessage);
  }

  if (newBootstrapMessages.length > 0) {
    messages = [...newBootstrapMessages, ...messages];
  }

  const agent = new Agent({
    initialState: {
      systemPrompt: fullSystemPrompt,
      model,
      messages,
      tools,
      thinkingLevel: groupConfig.model?.thinkingLevel ?? "off",
    },
    convertToLlm: defaultConvertToLlm,
    getApiKey: (provider: string) => {
      // KnownProvider: pi-ai の環境変数マッピングを使用
      const knownKey = getEnvApiKey(provider);
      if (knownKey) return knownKey;

      // カスタムプロバイダー: credential-proxy.json を読んで envVars から取得
      return getCustomProviderApiKey(provider);
    },
  });

  const pendingAppends: Promise<void>[] = [];
  let response = "";

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      pendingAppends.push(appendMessage(groupName, sessionId, event.message));
      if (isAssistantMessage(event.message)) {
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
      if (groupConfig.toolLogArgs) {
        payload.args = event.args;
      }
      process.stderr.write(`__DISCORD_EVENT__:${JSON.stringify(payload)}\n`);
    }
  });

  await agent.prompt(content);
  await Promise.all(pendingAppends);
  return response;
}

const PayloadSchema = z.object({
  groupName: z.string(),
  sessionId: z.string(),
  content: z.string(),
  groupConfig: AgentConfigSchema,
});

// CLIエントリポイント（import時は実行しない）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    await waitForNetwork();
    const raw = await text(process.stdin);
    const payload = PayloadSchema.parse(JSON.parse(raw || "{}"));

    const response = await runAgentLoop(
      payload.groupName,
      payload.sessionId,
      payload.content,
      payload.groupConfig,
    );
    process.stdout.write(response);
  })().catch((err) => {
    const transient = isTransientError(err);
    const code = transient ? 2 : 1;
    process.stderr.write(
      `agent-runner エラー${transient ? "（一時的）" : ""}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(code);
  });
}
