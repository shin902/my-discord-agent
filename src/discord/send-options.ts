import {
  type MessageCreateOptions,
  MessageFlags,
  MessageFlagsBitField,
} from "discord.js";

type DiscordMessageOptions = object;

export function withDiscordSendOptions(
  payload: string,
  suppressEmbeds: boolean,
): string | MessageCreateOptions;
export function withDiscordSendOptions<T extends DiscordMessageOptions>(
  payload: T,
  suppressEmbeds: boolean,
): T;
export function withDiscordSendOptions(
  payload: string | DiscordMessageOptions,
  suppressEmbeds: boolean,
): string | DiscordMessageOptions;
export function withDiscordSendOptions(
  payload: string | DiscordMessageOptions,
  suppressEmbeds: boolean,
): string | DiscordMessageOptions {
  if (!suppressEmbeds) return payload;
  if (typeof payload === "string") {
    return { content: payload, flags: MessageFlags.SuppressEmbeds };
  }

  const existingFlags =
    "flags" in payload
      ? (payload.flags as ConstructorParameters<typeof MessageFlagsBitField>[0])
      : undefined;
  return {
    ...payload,
    flags: new MessageFlagsBitField(existingFlags).add(
      MessageFlags.SuppressEmbeds,
    ).bitfield,
  };
}
