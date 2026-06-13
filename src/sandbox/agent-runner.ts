import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

import { Agent } from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  getEnvApiKey,
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

const DEFAULT_SYSTEM_PROMPT = "あなたは役立つDiscordアシスタントです。";

// MEMORY.md をシステムプロンプトに注入する際の文字数上限
const MEMORY_CHAR_LIMIT = 2000;

// VM内で使用不可のツール（ネスト不可・ネイティブバイナリ依存）
const VM_UNSUPPORTED_TOOLS = new Set<string>([]);

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "role" in msg &&
    (msg as Record<string, unknown>).role === "assistant"
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

export async function runAgentLoop(
  groupName: string,
  sessionId: string,
  content: string,
  groupConfig: AgentConfig,
): Promise<string> {
  const [rawMessages, systemPrompt, skills, memory] = await Promise.all([
    loadMessages(groupName, sessionId),
    loadSystemPromptFromWorkspace(),
    loadSkills("/workspace/SKILLS", groupConfig.skills),
    loadMemoryFromWorkspace(),
  ]);

  // stopReason が error/aborted のメッセージはデバッグ用にセッションに残すが
  // LLM コンテキストには含めない（空の assistant ターンとして混入するのを防ぐ）
  const messages = rawMessages.filter((m) => {
    if (!isAssistantMessage(m)) return true;
    return m.stopReason !== "error" && m.stopReason !== "aborted";
  });

  const model = await resolveModel(
    groupConfig.model?.provider ?? FALLBACK_DEFAULT_MODEL.provider,
    groupConfig.model?.modelId ?? FALLBACK_DEFAULT_MODEL.modelId,
  );

  const tools = resolveTools(groupConfig.tools ?? []).filter(
    (t) => !VM_UNSUPPORTED_TOOLS.has(t.name),
  );

  const skillPrompt = formatSkillsForPrompt(skills);
  const memoryPrompt = formatMemoryForPrompt(memory);
  const datePrompt = formatDateForPrompt();
  const fullSystemPrompt = [
    systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    skillPrompt,
    memoryPrompt,
    datePrompt,
  ]
    .filter(Boolean)
    .join("\n\n");

  const agent = new Agent({
    initialState: {
      systemPrompt: fullSystemPrompt,
      model,
      messages,
      tools,
      thinkingLevel: groupConfig.model?.thinkingLevel ?? "off",
    },
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
