import type { DiscordCommandDefinition } from "./command-contract.js";
import { command as botCommand } from "./commands/bot.js";
import { command as skillCommand } from "./commands/skill.js";

/**
 * The authoritative list of every Slash Command owned by this application.
 * Deploy replaces the complete command set in each selected scope from here.
 */
export const DISCORD_COMMANDS: readonly DiscordCommandDefinition[] = [
  botCommand,
  skillCommand,
];

const commandsByName = new Map(
  DISCORD_COMMANDS.map((command) => [command.data.name, command]),
);

if (commandsByName.size !== DISCORD_COMMANDS.length) {
  throw new Error("Discord command names must be unique");
}

export function getDiscordCommand(
  name: string,
): DiscordCommandDefinition | undefined {
  return commandsByName.get(name);
}

export function getDiscordCommandData(): ReturnType<
  DiscordCommandDefinition["data"]["toJSON"]
>[] {
  return DISCORD_COMMANDS.map(({ data }) => data.toJSON());
}
