import type { ChatInputCommandInteraction } from "discord.js";
import {
  executeBotCommand,
  executeSkillCommand,
} from "../application/discord-command-service.js";
import { DEFAULT_DISCORD_BOT_ID } from "../config/constants.js";

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
  if (isListAction) await interaction.deferReply({ ephemeral: true });
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
  const content = isAcceptedTask
    ? formatBotTaskReply(botId, prompt, result.content)
    : result.content;
  if (isListAction) {
    await editReply(interaction, content);
  } else {
    await interaction.reply({
      content,
      ephemeral: !isAcceptedTask,
      allowedMentions: { parse: [], repliedUser: false },
    });
  }
}
