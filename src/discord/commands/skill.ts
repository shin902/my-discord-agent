import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandDefinition } from "../command-contract.js";
import { handleSkillCommand } from "../command-handlers.js";

export const command: DiscordCommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("skill")
    .setDescription("指定したスキルを明示的に実行します")
    .addStringOption((option) =>
      option
        .setName("skill")
        .setDescription("実行するスキル名")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option.setName("prompt").setDescription("スキルへの追加指示"),
    ),
  execute: (interaction, context) =>
    handleSkillCommand(interaction, context.discordBotId),
};

export default command;
