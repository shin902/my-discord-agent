import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandDefinition } from "../command-contract.js";
import { handleSessionModeCommand } from "../command-handlers.js";

export const command: DiscordCommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("session-mode")
    .setDescription("このセッションの応答モードを切り替えます")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("normal: 通常応答 / capture-only: 記録のみ")
        .setRequired(true)
        .addChoices(
          { name: "normal", value: "normal" },
          { name: "capture-only", value: "capture-only" },
        ),
    ),
  execute: (interaction, context) =>
    handleSessionModeCommand(interaction, context.discordBotId),
};
