import type { ChatInputCommandInteraction, Interaction } from "discord.js";
import type { DiscordCommandContext } from "./command-contract.js";
import { getDiscordCommand } from "./command-registry.js";
import { routeToolApprovalInteraction } from "./tool-approval.js";

const UNEXPECTED_ERROR_MESSAGE =
  "コマンドの処理中に予期しないエラーが発生しました。";

/** Route a chat-input interaction to the discovered command definition. */
export async function routeDiscordInteraction(
  interaction: ChatInputCommandInteraction,
  context: DiscordCommandContext,
): Promise<void> {
  const command = getDiscordCommand(interaction.commandName);
  if (!command) return;
  await command.execute(interaction, context);
}

async function replyToUnexpectedError(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: UNEXPECTED_ERROR_MESSAGE });
    } else {
      await interaction.reply({
        content: UNEXPECTED_ERROR_MESSAGE,
        ephemeral: true,
      });
    }
  } catch (replyError) {
    console.error(
      `[handler] /${interaction.commandName} コマンドのエラー応答に失敗しました:`,
      replyError,
    );
  }
}

/** Build the listener used by each Discord client. */
export function createDiscordInteractionRouter(
  discordBotId: string,
): (interaction: Interaction) => void {
  return (interaction) => {
    if (interaction.isButton()) {
      void routeToolApprovalInteraction(interaction, discordBotId).catch(
        (error) => {
          console.error(
            "[handler] tool approval interaction routing failed:",
            error,
          );
        },
      );
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    void routeDiscordInteraction(interaction, { discordBotId }).catch(
      async (error) => {
        await replyToUnexpectedError(interaction);
        console.error(
          `[handler] /${interaction.commandName} コマンドの処理に失敗しました:`,
          error,
        );
      },
    );
  };
}
