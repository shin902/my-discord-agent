import { readFile } from "node:fs/promises";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { Agent } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  resolveModel,
} from "../agent/model.js";
import { appendMessage, loadMessages } from "../agent/session.js";
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
const VM_UNSUPPORTED_TOOLS = new Set(["sandbox"]);

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
    loadSkills("/skills", groupConfig.skills),
  ]);

  const model = resolveModel(
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
    },
  });

  const pendingAppends: Promise<void>[] = [];
  let response = "";

  agent.subscribe((event) => {
    if (event.type === "message_end") {
      pendingAppends.push(appendMessage(groupName, sessionId, event.message));
      if ("role" in event.message && event.message.role === "assistant") {
        response = event.message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
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
