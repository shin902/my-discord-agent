import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("run"),
    Type.Literal("resume"),
    Type.Literal("list"),
  ]),
  bot: Type.String({ description: "Bot ID to use." }),
  prompt: Type.Optional(Type.String({ description: "Task or request to send to the Bot." })),
  session: Type.Optional(
    Type.String({ description: "Task Session handle to resume." }),
  ),
});

type BotAction = "run" | "resume" | "list";

export interface BotToolEndpoint {
  url: string;
  token: string;
}

export interface BotToolDetails {
  worker: "bot";
  action: BotAction;
  botId: string;
  session?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
  };
}

interface BotToolResponse {
  content?: unknown;
  session?: unknown;
  usage?: unknown;
  error?: unknown;
}

function isUsage(value: unknown): value is BotToolDetails["usage"] {
  if (typeof value !== "object" || value === null) return false;
  return ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(
    (key) =>
      typeof (value as Record<string, unknown>)[key] === "number" &&
      Number.isFinite((value as Record<string, unknown>)[key]),
  );
}

function details(
  action: BotAction,
  botId: string,
  response: BotToolResponse,
): BotToolDetails {
  return {
    worker: "bot",
    action,
    botId,
    ...(typeof response.session === "string"
      ? { session: response.session }
      : {}),
    ...(isUsage(response.usage) ? { usage: response.usage } : {}),
  };
}

export interface BotToolContext {
  endpoint: BotToolEndpoint;
  groupName: string;
  onUsage?: (usage: NonNullable<BotToolDetails["usage"]>) => void;
}

/** Create the synchronous agent-facing Bot delegation tool. */
export function createBotTool(
  context: BotToolContext,
): AgentTool<typeof parameters, BotToolDetails> {
  return {
    name: "bot",
    label: "Bot",
    description:
      "Delegate work synchronously to an existing Bot and receive the result after it finishes. run and resume wait for completion within the same tool call.",
    parameters,
    execute: async (
      _toolCallId,
      { action, bot, prompt, session },
      signal,
    ): Promise<AgentToolResult<BotToolDetails>> => {
      const response = await fetch(context.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-internal-token": context.endpoint.token,
        },
        body: JSON.stringify({
          groupName: context.groupName,
          action,
          bot,
          ...(prompt !== undefined ? { prompt } : {}),
          ...(session !== undefined ? { session } : {}),
        }),
        signal,
      });
      let payload: BotToolResponse;
      try {
        payload = (await response.json()) as BotToolResponse;
      } catch {
        throw new Error(`Bot tool request failed (HTTP ${response.status})`);
      }
      if (!response.ok || typeof payload.content !== "string") {
        throw new Error(
          typeof payload.error === "string"
            ? payload.error
            : `Bot tool request failed (HTTP ${response.status})`,
        );
      }
      const resultDetails = details(action, bot, payload);
      if (resultDetails.usage) context.onUsage?.(resultDetails.usage);
      return {
        content: [{ type: "text", text: payload.content }],
        details: resultDetails,
      };
    },
  };
}
