import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandDefinition } from "../command-contract.js";
import { handleContextCommand } from "../command-handlers.js";

export const command: DiscordCommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("clear")
    .setDescription("履歴を残して会話のコンテキストをリセットする"),
  execute: (interaction, context) =>
    handleContextCommand(interaction, "clear", context.discordBotId),
};
