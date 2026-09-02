import type { ChatInputCommandInteraction } from "discord.js";
import {
  executeBotCommand,
  executeSkillCommand,
} from "../application/discord-command-service.js";
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
  deferred = false,
): Promise<void> {
  if (deferred || interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, ephemeral: true });
  }
}

/** Adapt a Discord interaction into the skill application use case. */
export async function handleSkillCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  const channel = interaction.channel as InteractionChannel | null;
  const isThread = channel?.isThread?.() === true;
  const groupNameLookupId = await interactionGroupLookupId(interaction);
  let deferred = false;
  const result = await executeSkillCommand(
    {
      discordBotId,
      channelId: interaction.channelId,
      routingChannelId: groupNameLookupId,
      isThread,
      skillName: interaction.options.getString("skill", true).trim(),
      prompt: interaction.options.getString("prompt")?.trim() ?? "",
      idempotencyKey: `discord-interaction:${interaction.id}`,
      userId: interaction.user.id,
      userIsBot: interaction.user.bot,
    },
    {
      beforeEnqueue: async () => {
        await interaction.deferReply({ ephemeral: true });
        deferred = true;
      },
    },
  );
  await replyEphemeral(interaction, result.content, deferred);
}

/** Adapt a Discord interaction into the Bot task-session application use case. */
export async function handleBotCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  const groupNameLookupId = await interactionGroupLookupId(interaction);
  let deferred = false;
  const result = await executeBotCommand(
    {
      discordBotId,
      channelId: interaction.channelId,
      routingChannelId: groupNameLookupId,
      botId: interaction.options.getString("bot", true),
      action: interaction.options.getString("action") ?? "run",
      prompt: interaction.options.getString("prompt")?.trim() ?? "",
      sessionHandle: interaction.options.getString("session")?.trim() ?? "",
      idempotencyKey: `discord-interaction:${interaction.id}`,
    },
    {
      beforeEnqueue: async () => {
        await interaction.deferReply({ ephemeral: true });
        deferred = true;
      },
    },
  );
  await replyEphemeral(interaction, result.content, deferred);
}
