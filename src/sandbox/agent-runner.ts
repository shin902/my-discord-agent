import { fileURLToPath } from "node:url";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  getModels,
  getProviders,
  type KnownProvider,
  type TextContent,
} from "@earendil-works/pi-ai";
import {
  loadGroupConfig,
  loadGroupSystemPrompt,
} from "../config/group-config.js";
import { appendMessage, loadMessages } from "../agent/session.js";
import { webfetchTool } from "../tools/webfetch.js";

const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL_ID = "kimi-k2.6";
const DEFAULT_SYSTEM_PROMPT = "あなたは役立つDiscordアシスタントです。";

// microsandbox等のネイティブバイナリを含まないツールのみ登録
const SAFE_TOOLS: Record<string, AgentTool> = {
  webfetch: webfetchTool,
};

function resolveSafeTools(toolNames: string[]): AgentTool[] {
  return toolNames.flatMap((name) => {
    const tool = SAFE_TOOLS[name];
    if (!tool) return [];
    return [tool];
  });
}

export async function runAgentLoop(
  groupName: string,
  sessionId: string,
  content: string,
): Promise<string> {
  const [messages, groupConfig, systemPrompt] = await Promise.all([
    loadMessages(groupName, sessionId),
    loadGroupConfig(groupName),
    loadGroupSystemPrompt(groupName),
  ]);

  const providers = getProviders();
  const providerName = groupConfig.model?.provider ?? DEFAULT_PROVIDER;
  if (!providers.includes(providerName as KnownProvider)) {
    throw new Error(`不明なプロバイダ: ${providerName}`);
  }
  const modelId = groupConfig.model?.modelId ?? DEFAULT_MODEL_ID;
  const model = getModels(providerName as KnownProvider).find(
    (m) => m.id === modelId,
  );
  if (!model) {
    throw new Error(`不明なモデル: ${modelId} (provider: ${providerName})`);
  }

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

// CLIエントリポイント（import時は実行しない）
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const payload = JSON.parse(process.argv[2] ?? "{}") as {
    groupName: string;
    sessionId: string;
    content: string;
  };

  runAgentLoop(payload.groupName, payload.sessionId, payload.content)
    .then((response) => {
      process.stdout.write(response);
    })
    .catch((err) => {
      process.stderr.write(
        `agent-runner エラー: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
