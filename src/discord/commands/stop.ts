import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandDefinition } from "../command-contract.js";
import { handleStopCommand } from "../command-handlers.js";

export const command: DiscordCommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("stop")
    .setDescription("実行中のAgentを停止します"),
  execute: (interaction, context) =>
    handleStopCommand(interaction, context.discordBotId),
};
