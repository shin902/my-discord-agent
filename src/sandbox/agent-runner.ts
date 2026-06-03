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

import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  resolveModel,
} from "../agent/model.js";
import { appendMessage, loadMessages } from "../agent/session.js";
import { loadCredentialProxy } from "../config/credential-proxy.js";
import {
  type GroupJsonConfig,
  GroupJsonSchema,
} from "../config/group-config.js";
import { loadSkills } from "../skills/loader.js";
import { formatSkillsForPrompt } from "../skills/prompt.js";
import { resolveTools } from "../tools/registry.js";
import { isTransientError } from "../utils/error.js";

const DEFAULT_SYSTEM_PROMPT = "あなたは役立つDiscordアシスタントです。";

// VM内で使用不可のツール（ネスト不可・ネイティブバイナリ依存）
const VM_UNSUPPORTED_TOOLS = new Set<string>([]);

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

export async function runAgentLoop(
  groupName: string,
  sessionId: string,
  content: string,
  groupConfig: GroupJsonConfig,
): Promise<string> {
  const [messages, systemPrompt, skills] = await Promise.all([
    loadMessages(groupName, sessionId),
    loadSystemPromptFromWorkspace(),
    loadSkills("/workspace/SKILLS", groupConfig.skills),
  ]);

  const model = await resolveModel(
    groupConfig.model?.provider ?? DEFAULT_PROVIDER,
    groupConfig.model?.modelId ?? DEFAULT_MODEL_ID,
  );

  const tools = resolveTools(groupConfig.tools ?? []).filter(
    (t) => !VM_UNSUPPORTED_TOOLS.has(t.name),
  );

  const skillPrompt = formatSkillsForPrompt(skills);
  const fullSystemPrompt = [systemPrompt ?? DEFAULT_SYSTEM_PROMPT, skillPrompt]
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
      if ("role" in event.message && event.message.role === "assistant") {
        const asstMsg = event.message as unknown as AssistantMessage;
        if (asstMsg.errorMessage) {
          process.stderr.write(
            `__DISCORD_EVENT__:${JSON.stringify({ type: "error", message: asstMsg.errorMessage })}\n`,
          );
        } else {
          pendingAppends.push(
            appendMessage(groupName, sessionId, event.message),
          );
          response = asstMsg.content
            .filter((c): c is TextContent => c.type === "text")
            .map((c) => c.text)
            .join("");
        }
      } else {
        pendingAppends.push(appendMessage(groupName, sessionId, event.message));
      }
    }

    if (event.type === "tool_execution_start") {
      process.stderr.write(
        `__DISCORD_EVENT__:${JSON.stringify({
          type: "tool_start",
          toolName: event.toolName,
          args: event.args,
        })}\n`,
      );
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
  groupConfig: GroupJsonSchema,
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
