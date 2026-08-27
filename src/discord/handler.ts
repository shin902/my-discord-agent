import { type Client, Events, type Message } from "discord.js";
import { handleBotCommand, synchronizeBotCommand } from "./commands.js";
import { handleLiveDiscordMessage } from "./intake.js";

/** Discordイベントハンドラーを指定したClientへ登録する。 */
export function registerHandlers(
  client: Client,
  onReady?: () => Promise<void> | void,
): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`起動しました: ${c.user.tag}`);
    void synchronizeBotCommand(c).catch((error) =>
      console.error("[handler] /bot コマンドの同期に失敗しました:", error),
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
    handleLiveDiscordMessage(message).catch((error) =>
      console.error("[handler] メッセージ取り込みに失敗しました:", error),
    ),
  );

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "bot")
      return;
    void handleBotCommand(interaction).catch((error) =>
      console.error("[handler] /bot コマンドの処理に失敗しました:", error),
    );
  });
}
