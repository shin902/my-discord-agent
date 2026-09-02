import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
} from "discord.js";

/** Context supplied by the Discord adapter without exposing runtime internals. */
export interface DiscordCommandContext {
  discordBotId: string;
}

/** Canonical file-based contract for a Discord chat-input command. */
export interface DiscordCommandDefinition {
  data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;
  execute: (
    interaction: ChatInputCommandInteraction,
    context: DiscordCommandContext,
  ) => Promise<void>;
}
