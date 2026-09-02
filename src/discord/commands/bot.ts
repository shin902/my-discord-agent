import { SlashCommandBuilder } from "discord.js";
import type { DiscordCommandDefinition } from "../command-contract.js";
import { handleBotCommand } from "../command-handlers.js";

export const command: DiscordCommandDefinition = {
  data: new SlashCommandBuilder()
    .setName("bot")
    .setDescription("指定したBotへ依頼します")
    .addStringOption((option) =>
      option.setName("bot").setDescription("利用するBot ID").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("run（新規）、resume（続き）、list（一覧）")
        .addChoices(
          { name: "run", value: "run" },
          { name: "resume", value: "resume" },
          { name: "list", value: "list" },
        ),
    )
    .addStringOption((option) =>
      option.setName("prompt").setDescription("Botへの依頼内容"),
    )
    .addStringOption((option) =>
      option.setName("session").setDescription("resumeするTask Session handle"),
    ),
  execute: (interaction, context) =>
    handleBotCommand(interaction, context.discordBotId),
};
