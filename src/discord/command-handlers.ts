import type { ChatInputCommandInteraction } from "discord.js";
import {
  isAgentMemoryEligible,
  loadAgentMemoryConfig,
} from "../config/agent-memory.js";
import { pickAgentConfig } from "../config/agent-resolution.js";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import { findGroupByChannelId } from "../config/groups.js";
import {
  formatBotTaskSessionList,
  generateBotTaskSessionHandle,
  generateBotTaskSessionId,
  previewBotTaskPrompt,
} from "../queue/bot-task-sessions.js";
import type { BotTaskSession } from "../queue/repository.js";
import { getQueueRepository } from "../queue/repository.js";
import { DEFAULT_DISCORD_BOT_ID } from "./client.js";

type InteractionChannel = {
  isThread?: () => boolean;
  parentId?: string | null;
  fetch?: () => Promise<unknown>;
};

async function interactionGroupLookupId(
  interaction: ChatInputCommandInteraction,
): Promise<string> {
  const channel = interaction.channel as InteractionChannel | null;
  if (channel?.isThread?.() === true) {
    let parentId = channel.parentId;
    if (!parentId && channel.fetch) {
      const fetched = await channel.fetch().catch(() => null);
      parentId = (fetched as InteractionChannel | null)?.parentId;
    }
    if (parentId) return parentId;
  }
  return interaction.channelId;
}

async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, ephemeral: true });
  }
}

function validSessionHandle(handle: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(handle);
}

function validSkillName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/** Enqueue a forced skill invocation through the normal conversation path. */
export async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  const skillName = interaction.options.getString("skill", true).trim();
  const prompt = interaction.options.getString("prompt")?.trim() ?? "";
  if (!validSkillName(skillName)) {
    await replyEphemeral(
      interaction,
      "スキル名には英数字、ハイフン、アンダースコアのみ使用できます。",
    );
    return;
  }

  const channel = interaction.channel as InteractionChannel | null;
  const isThread = channel?.isThread?.() === true;
  const lookupId = await interactionGroupLookupId(interaction);
  const match = await findGroupByChannelId(lookupId);
  if (!match) {
    await replyEphemeral(
      interaction,
      "このチャンネルはAgentGroupに未登録です。",
    );
    return;
  }

  const expectedDiscordBotId = match.group.bot ?? DEFAULT_DISCORD_BOT_ID;
  if (discordBotId !== expectedDiscordBotId) {
    await replyEphemeral(
      interaction,
      "このDiscord BotはこのチャンネルのAgentGroupを担当していません。",
    );
    return;
  }

  if (match.channel.sessionMode === "shared" && isThread) {
    await replyEphemeral(
      interaction,
      "このコマンドは親チャンネルで実行してください。",
    );
    return;
  }
  if (match.channel.sessionMode !== "shared" && !isThread) {
    await replyEphemeral(
      interaction,
      "このコマンドはスレッド内で実行してください。",
    );
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const configOverride = pickAgentConfig(match.channel);
    let memoryUserId: string | undefined;
    try {
      const memoryConfig = await loadAgentMemoryConfig();
      const user = interaction.user;
      if (
        isAgentMemoryEligible(memoryConfig, {
          groupName: match.group.name,
          // /skill is the slash-command equivalent of the conversational
          // ./command path, so it is represented as a Default user turn.
          messageType: 0,
          userId: user.id,
          authorIsBot: user.bot,
        })
      ) {
        memoryUserId = user.id;
      }
    } catch (error) {
      // Memory capture is best-effort and must never block command enqueueing.
      console.error("[handler] Agent Memory eligibility check failed:", error);
    }
    await getQueueRepository().enqueue({
      channelId: interaction.channelId,
      groupName: match.group.name,
      routingChannelId: lookupId,
      sessionId: interaction.channelId,
      ...(memoryUserId ? { userId: memoryUserId } : {}),
      content: `./command ${skillName}${prompt ? ` ${prompt}` : ""}`,
      timestamp: new Date().toISOString(),
      idempotencyKey: `discord-interaction:${interaction.id}`,
      ...(Object.keys(configOverride).length > 0 ? { configOverride } : {}),
    });
    await interaction.editReply({
      content: `スキル「${skillName}」の実行を受け付けました。`,
    });
  } catch (error) {
    await replyEphemeral(
      interaction,
      `スキルの実行を受け付けられませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Enqueue a Bot request while retaining the normal delivery path. */
export async function handleBotCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  const botId = interaction.options.getString("bot", true);
  const action = interaction.options.getString("action") ?? "run";
  const prompt = interaction.options.getString("prompt")?.trim() ?? "";
  const handle = interaction.options.getString("session")?.trim() ?? "";

  const match = await findGroupByChannelId(
    await interactionGroupLookupId(interaction),
  );
  if (!match) {
    await replyEphemeral(
      interaction,
      "このチャンネルはAgentGroupに未登録です。",
    );
    return;
  }

  const expectedDiscordBotId = match.group.bot ?? DEFAULT_DISCORD_BOT_ID;
  if (discordBotId !== expectedDiscordBotId) {
    await replyEphemeral(
      interaction,
      "このDiscord BotはこのチャンネルのAgentGroupを担当していません。",
    );
    return;
  }

  try {
    const registry = await loadBotRegistry();
    resolveBotProfile(registry, botId, match.group.name);
  } catch (error) {
    await replyEphemeral(
      interaction,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  if (action !== "run" && action !== "resume" && action !== "list") {
    await replyEphemeral(
      interaction,
      "action は run、resume、list のいずれかです。",
    );
    return;
  }
  if (action === "list") {
    if (prompt || handle) {
      await replyEphemeral(
        interaction,
        "list では prompt と session は指定できません。",
      );
      return;
    }
    try {
      const sessions = getQueueRepository().listBotTaskSessions(
        match.group.name,
        botId,
      );
      await replyEphemeral(interaction, formatBotTaskSessionList(sessions));
    } catch (error) {
      await replyEphemeral(
        interaction,
        `Task Session一覧を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }
  if (!prompt) {
    await replyEphemeral(interaction, "prompt は必須です。");
    return;
  }
  if (action === "run" && handle) {
    await replyEphemeral(
      interaction,
      "新規実行では session を指定できません。resume を使用してください。",
    );
    return;
  }
  if (action === "resume" && !validSessionHandle(handle)) {
    await replyEphemeral(
      interaction,
      "不正または空のTask Session handleです。",
    );
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const repository = getQueueRepository();
    const now = new Date().toISOString();
    const payload = {
      channelId: interaction.channelId,
      groupName: match.group.name,
      // Task Session identity is deliberately independent from the delivery
      // channel/thread so Bot work never shares normal conversation history.
      content: prompt,
      timestamp: now,
      idempotencyKey: `discord-interaction:${interaction.id}`,
      botId,
    };
    let session: BotTaskSession;
    if (action === "resume") {
      const result = repository.resumeBotTaskSessionAndEnqueue(
        handle,
        match.group.name,
        botId,
        now,
        payload,
      );
      if (!result) {
        await interaction.editReply({
          content: "指定されたTask Sessionは見つかりません。",
        });
        return;
      }
      session = result.session;
    } else {
      const result = repository.createBotTaskSessionAndEnqueue(
        {
          sessionId: generateBotTaskSessionId(),
          handle: generateBotTaskSessionHandle(),
          groupName: match.group.name,
          botId,
          sourceKey: `discord-interaction:${interaction.id}`,
          createdAt: now,
          preview: previewBotTaskPrompt(prompt),
        },
        payload,
      );
      session = result.session;
    }
    await interaction.editReply({
      content: `Botへの依頼を受け付けました。Task Session: ${session.handle}`,
    });
  } catch (error) {
    await replyEphemeral(
      interaction,
      `Botへの依頼を受け付けられませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
