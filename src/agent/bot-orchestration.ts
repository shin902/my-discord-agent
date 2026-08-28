import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveAgentConfig } from "../config/agent-resolution.js";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import { resolveModelConfig } from "../config/default-model.js";
import { findGroupByName } from "../config/groups.js";
import { resolveProviderConcurrency } from "../config/providers.js";
import { acquireLlmLock } from "../queue/llm-mutex.js";
import type { BotTaskSession } from "../queue/repository.js";
import { getQueueRepository } from "../queue/repository.js";
import { type AgentExecutionTiming, sendMessage } from "./manager.js";

const BotRequestSchema = z.object({
  groupName: z.string().min(1),
  action: z.enum(["run", "resume", "list"]),
  bot: z.string().min(1),
  prompt: z.string().optional(),
  session: z.string().optional(),
});

export interface BotToolResponse {
  content: string;
  action: "run" | "resume" | "list";
  botId: string;
  session?: string;
  usage?: AgentExecutionTiming["usage"];
}

function taskSessionId(): string {
  return `bot-task-${randomUUID()}`;
}

function taskSessionHandle(): string {
  return `task-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function taskPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}

function formatTaskSessionList(sessions: BotTaskSession[]): string {
  if (sessions.length === 0) return "利用可能なTask Sessionはありません。";
  const lines: string[] = [];
  for (const session of sessions) {
    const line = `- ${session.handle} | ${session.botId} | created: ${session.createdAt} | last-used: ${session.lastUsedAt} | ${session.preview}`;
    if (
      `Task Session一覧（${sessions.length}件）:\n${[...lines, line].join("\n")}`
        .length > 1_800
    )
      break;
    lines.push(line);
  }
  const suffix =
    sessions.length > lines.length
      ? `\n（他${sessions.length - lines.length}件）`
      : "";
  return `Task Session一覧（${sessions.length}件）:\n${lines.join("\n")}${suffix}`;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** Execute an agent-facing Bot request synchronously without queue delivery. */
export async function handleBotToolRequest(
  req: IncomingMessage,
  res: ServerResponse,
  scope?: string,
  heldProvider?: string,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", () => {
    if (!res.writableEnded) abort();
  });

  try {
    const request = BotRequestSchema.parse(
      JSON.parse(await readRequestBody(req)),
    );
    if (scope !== undefined && scope !== request.groupName) {
      throw new Error("Botのグループ境界を越えて利用できません");
    }
    const group = await findGroupByName(request.groupName);
    if (!group) throw new Error(`グループが未定義です: ${request.groupName}`);
    const registry = await loadBotRegistry();
    const profile = resolveBotProfile(registry, request.bot, group.name);

    if (request.action === "list") {
      if (request.prompt !== undefined || request.session !== undefined) {
        throw new Error("list では prompt と session は指定できません");
      }
      writeJson(res, 200, {
        content: formatTaskSessionList(
          getQueueRepository().listBotTaskSessions(group.name, request.bot),
        ),
        action: request.action,
        botId: request.bot,
      } satisfies BotToolResponse);
      return;
    }

    const prompt = request.prompt?.trim() ?? "";
    if (!prompt) throw new Error("prompt は必須です");
    if (request.action === "run" && request.session !== undefined) {
      throw new Error("新規実行では session を指定できません");
    }
    if (request.action === "resume" && !request.session) {
      throw new Error("resume には session が必須です");
    }

    const configOverride = resolveAgentConfig(group, profile);
    const model = await resolveModelConfig(configOverride.model);
    const concurrency = await resolveProviderConcurrency(model.provider);
    if (
      heldProvider !== undefined &&
      heldProvider !== model.provider &&
      concurrency === "serial"
    ) {
      throw new Error(
        "親がserial providerのlockを保持しているため、異なるserial providerへの同期Bot呼び出しは利用できません",
      );
    }

    const repository = getQueueRepository();
    const now = new Date().toISOString();
    let session: BotTaskSession | undefined;
    if (request.action === "resume") {
      session = repository.findBotTaskSession(
        request.session as string,
        group.name,
        request.bot,
      );
      if (!session) throw new Error("指定されたTask Sessionは見つかりません");
      repository.touchBotTaskSession(session.sessionId, session.channelId, now);
    } else {
      session = repository.createBotTaskSession({
        sessionId: taskSessionId(),
        handle: taskSessionHandle(),
        groupName: group.name,
        botId: request.bot,
        channelId: `agent:${request.groupName}`,
        createdAt: now,
        preview: taskPreview(prompt),
      });
    }

    // The parent poller already holds its serial-provider lock. Re-acquiring it
    // would deadlock because the parent waits for this synchronous tool call.
    // Different serial providers were rejected above to avoid ABBA deadlocks;
    // parallel providers retain their no-wait mutex contract.
    const release =
      heldProvider === model.provider
        ? undefined
        : await acquireLlmLock(model.provider, concurrency, controller.signal);
    try {
      let timing: AgentExecutionTiming | undefined;
      const content = await sendMessage(group.name, session.sessionId, prompt, {
        configOverride,
        systemPromptAppend: profile.instructions,
        enableBotTool: false,
        signal: controller.signal,
        onExecutionTiming: (value) => {
          timing = value;
        },
      });
      if (content.trim() === "") throw new Error("Botが空の応答で終了しました");

      writeJson(res, 200, {
        content,
        action: request.action,
        botId: request.bot,
        session: session.handle,
        ...(timing?.usage ? { usage: timing.usage } : {}),
      } satisfies BotToolResponse);
    } finally {
      release?.();
    }
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    req.removeListener("aborted", abort);
  }
}
