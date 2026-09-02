import {
  type APIApplicationCommand,
  type Client,
  REST,
  Routes,
} from "discord.js";
import { DISCORD_COMMANDS, getDiscordCommandData } from "./command-registry.js";

export interface DiscordCommandSyncRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Synchronize known commands without replacing unrelated application commands. */
export async function synchronizeDiscordCommands(
  client: Client,
): Promise<void> {
  if (!client.application)
    throw new Error("Discord application が未初期化です");
  const existingCommands = await client.application.commands.fetch();
  for (const definition of DISCORD_COMMANDS) {
    const command = definition.data.toJSON();
    const existing = existingCommands.find(
      (registered) =>
        registered.name === command.name && registered.type === command.type,
    );
    if (existing) {
      await client.application.commands.edit(existing.id, command);
    } else {
      await client.application.commands.create(command);
    }
  }
}

/** Retry runtime command synchronization for callers that still opt into it. */
export async function synchronizeDiscordCommandsWithRetry(
  client: Client,
  options: DiscordCommandSyncRetryOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `[discord-command] コマンド同期を試行します (${attempt}/${maxAttempts})`,
    );
    try {
      await synchronizeDiscordCommands(client);
      console.log(
        `[discord-command] コマンド同期に成功しました (${attempt}/${maxAttempts})`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `[discord-command] コマンド同期に失敗しました (${attempt}/${maxAttempts}):`,
        error,
      );
      if (attempt < maxAttempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export type DiscordCommandDeployScope = "global" | "guild";

export interface DiscordCommandDeployOptions {
  applicationId: string;
  token: string;
  scope?: DiscordCommandDeployScope;
  guildId?: string;
  rest?: REST;
}

/** Deploy command definitions through REST, independently of the runtime Client. */
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
