import { type Client, Events, type Message } from "discord.js";
import { handleLiveDiscordMessage } from "./intake.js";

/** Discordイベントハンドラーを指定したClientへ登録する。 */
export function registerHandlers(
  client: Client,
  onReady?: () => Promise<void> | void,
): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`起動しました: ${c.user.tag}`);
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
}
