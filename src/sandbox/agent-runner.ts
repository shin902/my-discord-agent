import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
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

// CustomAgentMessages の拡張: AGENTS.md / MEMORY.md の初回注入に使うカスタムメッセージ型
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    contextBootstrap: {
      role: "prompt";
      customType: "bootstrap-context";
      content: string;
      timestamp: number;
    };
  }
}

type ContextBootstrapMessage = {
  role: "prompt";
  customType: "bootstrap-context";
  content: string;
  timestamp: number;
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

function isContextBootstrapMessage(
  msg: AgentMessage,
): msg is ContextBootstrapMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "role" in msg &&
    (msg as Record<string, unknown>).role === "prompt" &&
    "customType" in msg &&
    (msg as Record<string, unknown>).customType === "bootstrap-context"
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
 * prompt メッセージ（contextBootstrap）は最初の1件のみ user として展開し、残りは除外する。
 * セッションあたり bootstrap は1件しか書き込まれないため、実質的にフィルタが発動するケースはない。 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  let bootstrapSeen = false;
  return messages.flatMap((msg) => {
    if (isContextBootstrapMessage(msg)) {
      if (bootstrapSeen) return [];
      bootstrapSeen = true;
      return [{ role: "user", content: msg.content, timestamp: msg.timestamp }];
    }
    return [msg as Message];
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
  const messages = rawMessages.filter((m) => {
    if (!isAssistantMessage(m)) return true;
    return m.stopReason !== "error" && m.stopReason !== "aborted";
  });

  // セッションが初回（messages が空）かどうかで注入戦略を決定
  const isNewSession = messages.length === 0;
  // 既存セッションに bootstrap メッセージが含まれる場合は新方式セッション
  const hasBootstrap = messages.some(isContextBootstrapMessage);
  // フォールバック: 既存セッションで bootstrap がない場合（旧形式）
  const needsLegacyInjection = !isNewSession && !hasBootstrap;

  // 新規セッションの場合のみ AGENTS.md / MEMORY.md を読み込む
  // フォールバック（旧形式セッション）の場合も読み込む
  const shouldReadContextFiles = isNewSession || needsLegacyInjection;

  const [systemPrompt, skills, memory] = await Promise.all([
    shouldReadContextFiles
      ? loadSystemPromptFromWorkspace()
      : Promise.resolve(null),
    loadSkills("/workspace/SKILLS", groupConfig.skills),
    shouldReadContextFiles ? loadMemoryFromWorkspace() : Promise.resolve(null),
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

  let fullSystemPrompt: string;
  if (isNewSession || hasBootstrap) {
    // 新方式: AGENTS.md / MEMORY.md はシステムプロンプトに含めない。
    // hasBootstrap 時は shouldReadContextFiles = false なので systemPrompt = null になり
    // DEFAULT_SYSTEM_PROMPT にフォールバックする。AGENTS.md の指示は初回注入した
    // prompt ロールのメッセージが会話履歴として維持されるため、LLM には届いている。
    fullSystemPrompt = [
      systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      skillPrompt,
      datePrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
  } else {
    // フォールバック: 旧形式セッション（AGENTS.md / MEMORY.md をシステムプロンプトに含める）
    const memoryPrompt = formatMemoryForPrompt(memory);
    fullSystemPrompt = [
      systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      skillPrompt,
      memoryPrompt,
      datePrompt,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  // 新規セッションの場合、AGENTS.md / MEMORY.md を custom メッセージとして注入する
  if (isNewSession) {
    const contextParts: string[] = [];
    if (systemPrompt) {
      contextParts.push(`## エージェント設定 (AGENTS.md)\n\n${systemPrompt}`);
    }
    if (memory) {
      contextParts.push(formatMemoryForPrompt(memory));
    }

    if (contextParts.length > 0) {
      const bootstrapMessage: ContextBootstrapMessage = {
        role: "prompt",
        customType: "bootstrap-context",
        content: contextParts.join("\n\n"),
        timestamp: Date.now(),
      };
      // JSONL に書き込む
      await appendMessage(
        groupName,
        sessionId,
        bootstrapMessage as AgentMessage,
      );
      // messages 配列の先頭に追加
      messages.unshift(bootstrapMessage as AgentMessage);
    }
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
