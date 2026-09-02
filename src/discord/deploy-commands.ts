import { type APIApplicationCommand, REST, Routes } from "discord.js";
import { getDiscordCommandData } from "./command-registry.js";

export type DiscordCommandDeployScope = "global" | "guild";

export interface DiscordCommandDeployOptions {
  applicationId: string;
  token: string;
  scope?: DiscordCommandDeployScope;
  guildId?: string;
  rest?: REST;
}

/**
 * Replace every command in one application or guild scope from the registry.
 * The registry is the authoritative source; commands registered elsewhere in
 * the same scope are intentionally removed by Discord's bulk-overwrite API.
 * Runtime startup does not call this function.
 */
export async function deployDiscordCommands(
  options: DiscordCommandDeployOptions,
): Promise<APIApplicationCommand[]> {
  const scope = options.scope ?? "global";
  if (scope === "guild" && !options.guildId) {
    throw new Error("guild deploy には guildId が必要です");
  }
  const rest =
    options.rest ?? new REST({ version: "10" }).setToken(options.token);
  const route =
    scope === "guild"
      ? Routes.applicationGuildCommands(
          options.applicationId,
          options.guildId as string,
        )
      : Routes.applicationCommands(options.applicationId);
  return (await rest.put(route, {
    body: getDiscordCommandData(),
  })) as APIApplicationCommand[];
}
