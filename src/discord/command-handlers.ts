import type { ChatInputCommandInteraction } from "discord.js";
import {
  executeBotCommand,
  executeSkillCommand,
  executeSteerCommand,
  executeStopCommand,
} from "../application/discord-command-service.js";
import { DEFAULT_DISCORD_BOT_ID } from "../config/constants.js";
import { splitMessage } from "../utils/splitMessage.js";

type InteractionChannel = {
  isThread?: () => boolean;
  parentId?: string | null;
  fetch?: () => Promise<unknown>;
  send?: (options: {
    content: string;
    allowedMentions: { parse: never[]; repliedUser: boolean };
  }) => Promise<unknown>;
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

async function editReply(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  await interaction.editReply({ content });
}

function formatBotTaskReply(
  botId: string,
  prompt: string,
  result: string,
): string {
  return `Bot: ${botId}\nPrompt: ${prompt}\n${result}`;
}

/** Adapt a Discord interaction into the skill application use case. */
export async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.channel as InteractionChannel | null;
  const isThread = channel?.isThread?.() === true;
  const groupNameLookupId = await interactionGroupLookupId(interaction);
  const result = await executeSkillCommand({
    discordBotId,
    channelId: interaction.channelId,
    routingChannelId: groupNameLookupId,
    isThread,
    skillName: interaction.options.getString("skill", true).trim(),
    prompt: interaction.options.getString("prompt")?.trim() ?? "",
    idempotencyKey: `discord-interaction:${interaction.id}`,
    userId: interaction.user.id,
    userIsBot: interaction.user.bot,
  });
  await editReply(interaction, result);
}

/** Adapt a Discord interaction into the stop application use case. */
export async function handleStopCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.channel as InteractionChannel | null;
  const isThread = channel?.isThread?.() === true;
  const routingChannelId = await interactionGroupLookupId(interaction);
  const result = await executeStopCommand({
    discordBotId,
    channelId: interaction.channelId,
    routingChannelId,
    isThread,
  });
  await editReply(interaction, result);
}

/** Adapt a Discord interaction into the steering application use case. */
export async function handleSteerCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const channel = interaction.channel as InteractionChannel | null;
  const isThread = channel?.isThread?.() === true;
  const groupNameLookupId = await interactionGroupLookupId(interaction);
  const instruction = interaction.options.getString("instruction", true).trim();
  const result = await executeSteerCommand({
    discordBotId,
    channelId: interaction.channelId,
    routingChannelId: groupNameLookupId,
    isThread,
    instruction,
  });
  await editReply(interaction, result);
}

/** Adapt a Discord interaction into the Bot task-session application use case. */
export async function handleBotCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  const botId = interaction.options.getString("bot", true);
  const action = interaction.options.getString("action") ?? "run";
  const prompt = interaction.options.getString("prompt")?.trim() ?? "";
  const isTaskAction = action === "run" || action === "resume";
  const isListAction = action === "list";
  await interaction.deferReply({ ephemeral: true });
  const groupNameLookupId = await interactionGroupLookupId(interaction);
  const result = await executeBotCommand({
    discordBotId,
    channelId: interaction.channelId,
    routingChannelId: groupNameLookupId,
    botId,
    action,
    prompt,
    sessionHandle: interaction.options.getString("session")?.trim() ?? "",
    idempotencyKey: `discord-interaction:${interaction.id}`,
  });
  const isAcceptedTask = isTaskAction && result.accepted;
  if (!isAcceptedTask || isListAction) {
    await editReply(interaction, result.content);
    return;
  }

  const channel = interaction.channel as InteractionChannel | null;
  if (!channel?.send) {
    throw new Error("Bot receipt destination is unavailable");
  }
  for (const chunk of splitMessage(
    formatBotTaskReply(botId, prompt, result.content),
  )) {
    await channel.send({
      content: chunk,
      allowedMentions: { parse: [], repliedUser: false },
    });
  }
  try {
    await interaction.deleteReply();
  } catch (error) {
    console.error("[handler] Bot receipt ACK cleanup failed:", error);
  }
}
