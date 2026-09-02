import {
  isAgentMemoryEligible,
  loadAgentMemoryConfig,
} from "../config/agent-memory.js";
import { pickAgentConfig } from "../config/agent-resolution.js";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import { DEFAULT_DISCORD_BOT_ID } from "../config/constants.js";
import { findGroupByChannelId } from "../config/groups.js";
import {
  formatBotTaskSessionList,
  generateBotTaskSessionHandle,
  generateBotTaskSessionId,
  previewBotTaskPrompt,
} from "../queue/bot-task-sessions.js";
import type { BotTaskSession } from "../queue/repository.js";
import { getQueueRepository } from "../queue/repository.js";

export interface SkillCommandRequest {
  discordBotId: string;
  channelId: string;
  routingChannelId: string;
  isThread: boolean;
  skillName: string;
  prompt: string;
  idempotencyKey: string;
  userId: string;
  userIsBot: boolean;
}

export interface BotCommandRequest {
  discordBotId: string;
  channelId: string;
  routingChannelId: string;
  botId: string;
  action: string;
  prompt: string;
  sessionHandle: string;
  idempotencyKey: string;
}

function validSessionHandle(handle: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(handle);
}

function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** Execute the skill use case without depending on Discord.js. */
export async function executeSkillCommand(
  request: SkillCommandRequest,
): Promise<string> {
  if (!validSkillName(request.skillName)) {
    return "スキル名には英数字、ハイフン、アンダースコアのみ使用できます。";
  }

  const match = await findGroupByChannelId(request.routingChannelId);
  if (!match) return "このチャンネルはAgentGroupに未登録です。";

  const expectedDiscordBotId = match.group.bot ?? DEFAULT_DISCORD_BOT_ID;
  if (request.discordBotId !== expectedDiscordBotId) {
    return "このDiscord BotはこのチャンネルのAgentGroupを担当していません。";
  }

  if (match.channel.sessionMode === "shared" && request.isThread) {
    return "このコマンドは親チャンネルで実行してください。";
  }
  if (match.channel.sessionMode !== "shared" && !request.isThread) {
    return "このコマンドはスレッド内で実行してください。";
  }

  try {
    const configOverride = pickAgentConfig(match.channel);
    let memoryUserId: string | undefined;
    try {
      const memoryConfig = await loadAgentMemoryConfig();
      if (
        isAgentMemoryEligible(memoryConfig, {
          groupName: match.group.name,
          // /skill is the slash-command equivalent of the conversational
          // ./command path, so it is represented as a Default user turn.
          messageType: 0,
          userId: request.userId,
          authorIsBot: request.userIsBot,
        })
      ) {
        memoryUserId = request.userId;
      }
    } catch (error) {
      // Memory capture is best-effort and must never block command enqueueing.
      console.error("[handler] Agent Memory eligibility check failed:", error);
    }

    await getQueueRepository().enqueue({
      channelId: request.channelId,
      groupName: match.group.name,
      routingChannelId: request.routingChannelId,
      sessionId: request.channelId,
      ...(memoryUserId ? { userId: memoryUserId } : {}),
      content: `./command ${request.skillName}${request.prompt ? ` ${request.prompt}` : ""}`,
      timestamp: new Date().toISOString(),
      idempotencyKey: request.idempotencyKey,
      ...(Object.keys(configOverride).length > 0 ? { configOverride } : {}),
    });
    return `スキル「${request.skillName}」の実行を受け付けました。`;
  } catch (error) {
    return `スキルの実行を受け付けられませんでした: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/** Execute the Bot task-session use case without depending on Discord.js. */
export async function executeBotCommand(
  request: BotCommandRequest,
): Promise<string> {
  const match = await findGroupByChannelId(request.routingChannelId);
  if (!match) return "このチャンネルはAgentGroupに未登録です。";

  const expectedDiscordBotId = match.group.bot ?? DEFAULT_DISCORD_BOT_ID;
  if (request.discordBotId !== expectedDiscordBotId) {
    return "このDiscord BotはこのチャンネルのAgentGroupを担当していません。";
  }

  try {
    const registry = await loadBotRegistry();
    resolveBotProfile(registry, request.botId, match.group.name);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  if (
    request.action !== "run" &&
    request.action !== "resume" &&
    request.action !== "list"
  ) {
    return "action は run、resume、list のいずれかです。";
  }
  if (request.action === "list") {
    if (request.prompt || request.sessionHandle) {
      return "list では prompt と session は指定できません。";
    }
    try {
      const sessions = getQueueRepository().listBotTaskSessions(
        match.group.name,
        request.botId,
      );
      return formatBotTaskSessionList(sessions);
    } catch (error) {
      return `Task Session一覧を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!request.prompt) return "prompt は必須です。";
  if (request.action === "run" && request.sessionHandle) {
    return "新規実行では session を指定できません。resume を使用してください。";
  }
  if (
    request.action === "resume" &&
    !validSessionHandle(request.sessionHandle)
  ) {
    return "不正または空のTask Session handleです。";
  }

  try {
    const repository = getQueueRepository();
    const now = new Date().toISOString();
    const payload = {
      channelId: request.channelId,
      groupName: match.group.name,
      content: request.prompt,
      timestamp: now,
      idempotencyKey: request.idempotencyKey,
      botId: request.botId,
    };
    let session: BotTaskSession;
    if (request.action === "resume") {
      const result = repository.resumeBotTaskSessionAndEnqueue(
        request.sessionHandle,
        match.group.name,
        request.botId,
        now,
        payload,
      );
      if (!result) return "指定されたTask Sessionは見つかりません。";
      session = result.session;
    } else {
      const result = repository.createBotTaskSessionAndEnqueue(
        {
          sessionId: generateBotTaskSessionId(),
          handle: generateBotTaskSessionHandle(),
          groupName: match.group.name,
          botId: request.botId,
          sourceKey: request.idempotencyKey,
          createdAt: now,
          preview: previewBotTaskPrompt(request.prompt),
        },
        payload,
      );
      session = result.session;
    }
    return `Botへの依頼を受け付けました。Task Session: ${session.handle}`;
  } catch (error) {
    return `Botへの依頼を受け付けられませんでした: ${error instanceof Error ? error.message : String(error)}`;
  }
}
