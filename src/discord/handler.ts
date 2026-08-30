import { type Client, Events, type Message } from "discord.js";
import { DEFAULT_DISCORD_BOT_ID } from "./client.js";
import {
  handleBotCommand,
  synchronizeBotCommandWithRetry,
} from "./commands.js";
import { handleLiveDiscordMessage } from "./intake.js";

/** Discordイベントハンドラーを指定したClientへ登録する。 */
export function registerHandlers(
  client: Client,
  onReady?: () => Promise<void> | void,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`起動しました: ${c.user.tag}`);
    void synchronizeBotCommandWithRetry(c).catch((error) =>
      console.error("[handler] /bot コマンドの同期を断念しました:", error),
    );
    if (onReady) {
      void Promise.resolve()
        .then(onReady)
        .catch((error) => {
          console.error(
            "[discord-backfill] 起動時履歴復旧に失敗しました:",
            error,
          );
        });
    }
  });

  client.on(Events.MessageCreate, (message: Message) =>
    handleLiveDiscordMessage(message, discordBotId).catch((error) =>
      console.error("[handler] メッセージ取り込みに失敗しました:", error),
    ),
  );

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "bot")
      return;
    void handleBotCommand(interaction, discordBotId).catch((error) =>
      console.error("[handler] /bot コマンドの処理に失敗しました:", error),
    );
  });
}
