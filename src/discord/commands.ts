import {
  type ChatInputCommandInteraction,
  type Client,
  SlashCommandBuilder,
} from "discord.js";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import { findGroupByChannelId } from "../config/groups.js";
import { getQueueRepository } from "../queue/repository.js";
import type { QueueInput } from "../queue/types.js";

export const BOT_COMMAND = new SlashCommandBuilder()
  .setName("bot")
  .setDescription("指定したBotに1回だけ依頼します")
  .addStringOption((option) =>
    option.setName("bot").setDescription("利用するBot ID").setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("prompt")
      .setDescription("Botへの依頼内容")
      .setRequired(true),
  );

/** Synchronize the single command owned by this application. */
export async function synchronizeBotCommand(client: Client): Promise<void> {
  if (!client.application)
    throw new Error("Discord application が未初期化です");
  await client.application.commands.set([BOT_COMMAND.toJSON()]);
}

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

/** Enqueue a one-shot Bot request while retaining the normal delivery path. */
export async function handleBotCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const botId = interaction.options.getString("bot", true);
  const prompt = interaction.options.getString("prompt", true);

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

  await interaction.deferReply({ ephemeral: true });
  try {
    const payload: QueueInput = {
      channelId: interaction.channelId,
      groupName: match.group.name,
      // One-shot Bot commands deliberately use the existing channel/thread
      // session identity until the independent Bot session design is added.
      sessionId: interaction.channelId,
      content: prompt,
      timestamp: new Date().toISOString(),
      idempotencyKey: `discord-interaction:${interaction.id}`,
      botId,
    };
    await getQueueRepository().enqueue(payload);
    await interaction.editReply({ content: "Botへの依頼を受け付けました。" });
  } catch (error) {
    await replyEphemeral(
      interaction,
      `Botへの依頼を受け付けられませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
