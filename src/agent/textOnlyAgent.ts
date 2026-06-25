import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  TextContent,
} from "@earendil-works/pi-ai";

export interface TextOnlyAgentOptions {
  systemPrompt: string;
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
  prompt: string;
  getApiKey: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
}

export interface TextOnlyAgentResult {
  text: string;
  agentMessage: AgentMessage | null;
}

/**
 * ホストプロセス上でツールなしのAgentを実行し、テキスト生成のみ行う。
 * tools を受け取らないため、コンテナ外でツール実行されることはない
 * （ツール付きAgentはsrc/sandbox/agent-runner.tsからのみ生成すること）。
 */
export async function runTextOnlyAgent(
  options: TextOnlyAgentOptions,
): Promise<TextOnlyAgentResult> {
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      messages: [],
      tools: [],
      thinkingLevel: options.thinkingLevel ?? "off",
    },
    getApiKey: options.getApiKey,
  });

  let text = "";
  let agentMessage: AgentMessage | null = null;
  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    const msg = event.message as AssistantMessage;
    if (msg.role !== "assistant") return;
    agentMessage = msg as AgentMessage;
    text = msg.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
  });

  await agent.prompt(options.prompt);
  return { text, agentMessage };
}
