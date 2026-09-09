import {
  type MessageCreateOptions,
  MessageFlags,
  MessageFlagsBitField,
} from "discord.js";

export const DEFAULT_DISCORD_SUPPRESS_EMBEDS = true;

type DiscordMessageOptions = object;

let suppressEmbeds = DEFAULT_DISCORD_SUPPRESS_EMBEDS;

export function setDiscordSuppressEmbeds(value: boolean): void {
  suppressEmbeds = value;
}

export function withDiscordSendOptions(
  payload: string,
): string | MessageCreateOptions;
export function withDiscordSendOptions<T extends DiscordMessageOptions>(
  payload: T,
): T;
export function withDiscordSendOptions(
  payload: string | DiscordMessageOptions,
): string | DiscordMessageOptions;
export function withDiscordSendOptions(
  payload: string | DiscordMessageOptions,
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
