import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { Api, Message, Model } from "@earendil-works/pi-ai";

export interface AgentExecutionOptions {
  systemPrompt: string;
  model: Model<Api>;
  messages: AgentMessage[];
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  prompt: string | AgentMessage[];
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  getApiKey: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  sessionId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentExecutionResult {
  response: string;
  agent: Agent;
}

function textFromAssistantMessage(message: AgentMessage): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter(
      (content): content is { type: "text"; text: string } =>
        content.type === "text",
    )
    .map((content) => content.text)
    .join("");
}

/**
 * Execute one in-process Agent run without session or bootstrap responsibilities.
 * Persistent callers own loading/saving their transcript around this primitive.
 */
export async function runAgent(
  options: AgentExecutionOptions,
): Promise<AgentExecutionResult> {
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model: options.model,
      messages: options.messages,
      tools: options.tools,
      thinkingLevel: options.thinkingLevel,
    },
    convertToLlm: options.convertToLlm,
    getApiKey: options.getApiKey,
    sessionId: options.sessionId,
  });

  const abort = () => agent.abort();
  if (options.signal?.aborted) {
    abort();
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }

  let response = "";
  agent.subscribe((event) => {
    options.onEvent?.(event);
    if (event.type === "message_end") {
      response = textFromAssistantMessage(event.message);
    }
  });

  try {
    if (typeof options.prompt === "string") {
      await agent.prompt(options.prompt);
    } else {
      await agent.prompt(options.prompt);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }

  return { response, agent };
}
