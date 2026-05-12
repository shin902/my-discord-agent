import { fileURLToPath } from "node:url";
import { text } from "node:stream/consumers";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
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
import { editTool, listTool, readTool, writeTool } from "../tools/fs.js";
import { webfetchTool } from "../tools/webfetch.js";
import { isTransientError } from "../utils/error.js";

const DEFAULT_SYSTEM_PROMPT = "あなたは役立つDiscordアシスタントです。";

// microsandbox等のネイティブバイナリを含まないツールのみ登録
const SAFE_TOOLS: Record<string, AgentTool> = {
  webfetch: webfetchTool,
  read: readTool,
  write: writeTool,
  list: listTool,
  edit: editTool,
};

// VM内で使用不可のツール（ネスト不可・ネイティブバイナリ依存）
const VM_UNSUPPORTED_TOOLS = new Set(["sandbox"]);

function resolveSafeTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    if (VM_UNSUPPORTED_TOOLS.has(name)) return [];
    const tool = SAFE_TOOLS[name];
    if (!tool) throw new Error(`不明なツール名: ${name}`);
    return [tool];
  });
}

export async function runAgentLoop(
  groupName: string,
  sessionId: string,
  content: string,
  groupConfig: GroupJsonConfig,
  systemPrompt: string | null,
): Promise<string> {
  const messages = await loadMessages(groupName, sessionId);

  const model = resolveModel(
    groupConfig.model?.provider ?? DEFAULT_PROVIDER,
    groupConfig.model?.modelId ?? DEFAULT_MODEL_ID,
  );

  const tools = resolveSafeTools(groupConfig.tools ?? []);

  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      model,
      messages,
      tools,
    },
  });

  let response = "";
  agent.subscribe(async (event) => {
    if (event.type === "message_end") {
      await appendMessage(groupName, sessionId, event.message);
      if ("role" in event.message && event.message.role === "assistant") {
        response = event.message.content
          .filter((c): c is TextContent => c.type === "text")
          .map((c) => c.text)
          .join("");
      }
    }
  });

  await agent.prompt(content);
  return response;
}

const PayloadSchema = z.object({
  groupName: z.string(),
  sessionId: z.string(),
  content: z.string(),
  groupConfig: GroupJsonSchema,
  systemPrompt: z.string().nullable(),
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
      payload.systemPrompt,
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
