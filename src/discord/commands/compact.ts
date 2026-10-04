import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandDefinition } from "../command-contract.js";
import { handleContextCommand } from "../command-handlers.js";

export const command: DiscordCommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("compact")
    .setDescription("履歴を残して会話のコンテキストを要約・圧縮する"),
  execute: (interaction, context) =>
    handleContextCommand(interaction, "compact", context.discordBotId),
};
