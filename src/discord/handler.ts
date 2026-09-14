import { type Client, Events, type Message } from "discord.js";
import { DEFAULT_DISCORD_BOT_ID } from "../config/constants.js";
import { handleLiveDiscordMessage } from "./intake.js";
import { createDiscordInteractionRouter } from "./interaction-router.js";

const messageChains = new Map<string, Promise<void>>();

function ingestInChannelOrder(
  message: Message,
  discordBotId: string,
): Promise<void> {
  const next = (messageChains.get(message.channelId) ?? Promise.resolve())
    .then(() => handleLiveDiscordMessage(message, discordBotId))
    .then(() => undefined)
    .catch((error) =>
      console.error("[handler] メッセージ取り込みに失敗しました:", error),
    );
  messageChains.set(message.channelId, next);
  return next.finally(() => {
    if (messageChains.get(message.channelId) === next) {
      messageChains.delete(message.channelId);
    }
  });
}

/** Discordイベントハンドラーを指定したClientへ登録する。 */
export function registerHandlers(
  client: Client,
  onReady?: () => Promise<void> | void,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
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
    ingestInChannelOrder(message, discordBotId),
  );

  const routeInteraction = createDiscordInteractionRouter(discordBotId);
  client.on(Events.InteractionCreate, routeInteraction);
}
