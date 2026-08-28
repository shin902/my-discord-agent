import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const parameters = Type.Object({
  action: Type.Union([
    Type.Literal("run"),
    Type.Literal("resume"),
    Type.Literal("list"),
  ]),
  bot: Type.String({ description: "利用するBot ID" }),
  prompt: Type.Optional(Type.String({ description: "Botへの依頼内容" })),
  session: Type.Optional(
    Type.String({ description: "resumeするTask Session handle" }),
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
  action?: unknown;
  botId?: unknown;
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
      "既存のBotへ同期的に依頼し、実行完了後の結果を受け取る。run/resumeは同じtool call内で完了まで待機する。",
    parameters,
    execute: async (
      _toolCallId,
      { action, bot, prompt, session },
      signal,
      onUpdate?: AgentToolUpdateCallback<BotToolDetails>,
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
      onUpdate?.({
        content: [{ type: "text", text: "Bot completed" }],
        details: resultDetails,
      });
      return {
        content: [{ type: "text", text: payload.content }],
        details: resultDetails,
      };
    },
  };
}
