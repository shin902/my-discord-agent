import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { resolveAgentConfig } from "../config/agent-resolution.js";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import { resolveModelConfig } from "../config/default-model.js";
import { findGroupByName } from "../config/groups.js";
import { resolveProviderConcurrency } from "../config/providers.js";
import {
  formatBotTaskSessionList,
  generateBotTaskSessionHandle,
  generateBotTaskSessionId,
  previewBotTaskPrompt,
} from "../queue/bot-task-sessions.js";
import { acquireLlmLock } from "../queue/llm-mutex.js";
import { getQueueRepository } from "../queue/repository.js";
import { withBotTaskSessionAdmission } from "../queue/session-admission.js";
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
  session?: string;
  usage?: AgentExecutionTiming["usage"];
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
  approvalChannelId?: string,
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
        content: formatBotTaskSessionList(
          getQueueRepository().listBotTaskSessions(group.name, request.bot),
        ),
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
    const admitted =
      request.action === "resume"
        ? repository.resumeBotTaskSessionAndAdmission(
            request.session as string,
            group.name,
            request.bot,
            now,
          )
        : repository.createBotTaskSessionAndAdmission({
            sessionId: generateBotTaskSessionId(),
            handle: generateBotTaskSessionHandle(),
            groupName: group.name,
            botId: request.bot,
            createdAt: now,
            preview: previewBotTaskPrompt(prompt),
          });
    if (!admitted) throw new Error("指定されたTask Sessionは見つかりません");
    const { session, admission } = admitted;

    // Admission happens before the provider lock so a direct call cannot
    // overtake an earlier queued invocation. The ticket remains active until
    // sendMessage has settled, so later turns cannot append concurrently.
    let execution!: { content: string; timing?: AgentExecutionTiming };
    await withBotTaskSessionAdmission(
      repository,
      admission,
      async () => {
        const release =
          heldProvider === model.provider
            ? undefined
            : await acquireLlmLock(
                model.provider,
                concurrency,
                controller.signal,
              );
        try {
          let timing: AgentExecutionTiming | undefined;
          const content = await sendMessage(
            group.name,
            session.sessionId,
            prompt,
            {
              configOverride,
              systemPromptAppend: profile.instructions,
              enableBotTool: false,
              signal: controller.signal,
              approvalChannelId,
              onExecutionTiming: (value) => {
                timing = value;
              },
            },
          );
          if (content.trim() === "")
            throw new Error("Botが空の応答で終了しました");
          execution = { content, timing };
        } finally {
          release?.();
        }
      },
      controller.signal,
      {
        failIfBlocked:
          heldProvider === model.provider && concurrency === "serial",
      },
    );

    writeJson(res, 200, {
      content: execution.content,
      session: session.handle,
      ...(execution.timing?.usage ? { usage: execution.timing.usage } : {}),
    } satisfies BotToolResponse);
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    req.removeListener("aborted", abort);
  }
}
