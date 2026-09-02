import type { ChatInputCommandInteraction } from "discord.js";
import type { DiscordCommandContext } from "./command-contract.js";
import { getDiscordCommand } from "./command-registry.js";

/** Route a chat-input interaction to the discovered command definition. */
export async function routeDiscordInteraction(
  interaction: ChatInputCommandInteraction,
  context: DiscordCommandContext,
): Promise<void> {
  const command = getDiscordCommand(interaction.commandName);
  if (!command) return;
  await command.execute(interaction, context);
}

/** Build the listener used by each Discord client. */
export function createDiscordInteractionRouter(
  discordBotId: string,
): (interaction: ChatInputCommandInteraction) => void {
  return (interaction) => {
    void routeDiscordInteraction(interaction, { discordBotId }).catch((error) =>
      console.error(
        `[handler] /${interaction.commandName} コマンドの処理に失敗しました:`,
        error,
      ),
    );
  };
}
