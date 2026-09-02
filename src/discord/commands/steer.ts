import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandDefinition } from "../command-contract.js";
import { handleSteerCommand } from "../command-handlers.js";

export const command: DiscordCommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("steer")
    .setDescription("実行中のAgentへ方針転換を送ります")
    .addStringOption((option) =>
      option
        .setName("instruction")
        .setDescription("Agentへ送る方針転換の指示")
        .setMaxLength(4000)
        .setRequired(true),
    ),
  execute: (interaction, context) =>
    handleSteerCommand(interaction, context.discordBotId),
};
