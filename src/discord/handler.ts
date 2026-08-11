import { Events, type Message } from "discord.js";
import { client } from "./client.js";
import { handleLiveDiscordMessage, setStartupBackfillGate } from "./intake.js";

/**
 * Discordイベントハンドラーを登録する。
 * index.ts から一度だけ呼ぶ。
 *
 * onReady は履歴バックフィルを開始するための任意コールバック。ready直後に
 * ゲートを設定し、バックフィル中のライブイベントが古い履歴を追い越さない
 * ようにする。
 */
export function registerHandlers(onReady?: () => Promise<void> | void): void {
  client.once(Events.ClientReady, (c) => {
    console.log(`起動しました: ${c.user.tag}`);
    if (onReady) {
      const gate = Promise.resolve()
        .then(onReady)
        .catch((error) => {
          console.error(
            "[discord-backfill] 起動時履歴復旧に失敗しました:",
            error,
          );
        });
      setStartupBackfillGate(gate);
    }
  });

  client.on(Events.MessageCreate, (message: Message) =>
    handleLiveDiscordMessage(message).catch((error) =>
      console.error("[handler] メッセージ取り込みに失敗しました:", error),
    ),
  );
}
