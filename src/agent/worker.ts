import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
  loadGroupConfig,
  loadGroupSystemPrompt,
} from "../config/group-config.js";
import { resolveTools } from "../tools/registry.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  DEFAULT_SYSTEM_PROMPT,
  resolveModel,
} from "./manager.js";
import { appendMessage, loadMessages } from "./session.js";

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const { groupName, sessionId, content } = JSON.parse(
    Buffer.concat(chunks).toString(),
  ) as { groupName: string; sessionId: string; content: string };

  const [messages, groupConfig, systemPrompt] = await Promise.all([
    loadMessages(groupName, sessionId),
    loadGroupConfig(groupName),
    loadGroupSystemPrompt(groupName),
  ]);

  let model: ReturnType<typeof resolveModel>;
  try {
    model = resolveModel(
      groupConfig.model?.provider ?? DEFAULT_PROVIDER,
      groupConfig.model?.modelId ?? DEFAULT_MODEL_ID,
    );
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        response: `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`,
      }),
    );
    return;
  }

  let tools: AgentTool[];
  try {
    tools = resolveTools(groupConfig.tools ?? []);
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        response: `設定エラー: ${err instanceof Error ? err.message : "不明なエラー"}`,
      }),
    );
    return;
  }

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
  process.stdout.write(JSON.stringify({ response }));
}

main().catch((err) => {
  process.stderr.write(String(err));
  process.exit(1);
});
