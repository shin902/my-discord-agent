import { type APIApplicationCommand, REST, Routes } from "discord.js";
import type { DiscordConfig } from "../config/config.js";
import { getDiscordCommandData } from "./command-registry.js";

export type DiscordCommandDeployScope = "global" | "guild";

export interface DiscordCommandDeployOptions {
  applicationId: string;
  token: string;
  scope: DiscordCommandDeployScope;
  guildId?: string;
  rest?: REST;
}

export interface DiscordCommandDeployTarget {
  botId: string;
  applicationId: string;
  token: string;
}

export interface DiscordCommandDeploymentResult {
  botId: string;
  applicationId: string;
  status: "succeeded" | "failed";
  commandCount?: number;
  error?: string;
}

export class DiscordCommandDeploymentError extends Error {
  constructor(readonly results: readonly DiscordCommandDeploymentResult[]) {
    const failed = results
      .filter((result) => result.status === "failed")
      .map((result) => `${result.botId}: ${result.error ?? "unknown error"}`)
      .join("; ");
    const succeeded = results.filter(
      (result) => result.status === "succeeded",
    ).length;
    super(
      `Discord command deploy failed for ${failed}. ${succeeded} bot(s) succeeded, ${results.length - succeeded} bot(s) failed.`,
    );
    this.name = "DiscordCommandDeploymentError";
  }
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
  validateDeployScope(options.scope, options.guildId);
  const rest =
    options.rest ?? new REST({ version: "10" }).setToken(options.token);
  const route =
    options.scope === "guild"
      ? Routes.applicationGuildCommands(
          options.applicationId,
          options.guildId as string,
        )
      : Routes.applicationCommands(options.applicationId);
  return (await rest.put(route, {
    body: getDiscordCommandData(),
  })) as APIApplicationCommand[];
}

/**
 * Deploys the same authoritative command registry to every configured Bot
 * application. All targets are attempted so a partial failure is explicit.
 */
export async function deployDiscordCommandsToBots(options: {
  targets: readonly DiscordCommandDeployTarget[];
  scope: DiscordCommandDeployScope;
  guildId?: string;
  deploy?: (
    options: DiscordCommandDeployOptions,
  ) => Promise<APIApplicationCommand[]>;
}): Promise<readonly DiscordCommandDeploymentResult[]> {
  validateDeployScope(options.scope, options.guildId);
  const deploy = options.deploy ?? deployDiscordCommands;
  const results: DiscordCommandDeploymentResult[] = [];

  for (const target of options.targets) {
    try {
      const commands = await deploy({
        applicationId: target.applicationId,
        token: target.token,
        scope: options.scope,
        ...(options.guildId ? { guildId: options.guildId } : {}),
      });
      results.push({
        botId: target.botId,
        applicationId: target.applicationId,
        status: "succeeded",
        commandCount: commands.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        botId: target.botId,
        applicationId: target.applicationId,
        status: "failed",
        // REST/client errors must never echo a Bot token into operator output.
        error: message.replaceAll(target.token, "[REDACTED]"),
      });
    }
  }

  if (results.some((result) => result.status === "failed")) {
    throw new DiscordCommandDeploymentError(results);
  }
  return results;
}

function validateDeployScope(
  scope: DiscordCommandDeployScope,
  guildId: string | undefined,
): void {
  if (scope !== "global" && scope !== "guild") {
    throw new Error("usage: pnpm discord:deploy [global|guild] [guild-id]");
  }
  if (scope === "guild" && !guildId) {
    throw new Error("guild deploy には guildId が必要です");
  }
  if (scope === "global" && guildId) {
    throw new Error("global deploy には guildId を指定できません");
  }
}

/** Resolve every configured Discord Bot for deploy. */
export function resolveDiscordCommandDeployTargets(
  config: DiscordConfig,
  env: NodeJS.ProcessEnv = process.env,
): DiscordCommandDeployTarget[] {
  return Object.entries(config.bots).map(([botId, bot]) => {
    const token = env[bot.tokenEnv];
    if (!token) {
      throw new Error(
        `Discord Bot "${botId}" の環境変数 ${bot.tokenEnv} が設定されていません`,
      );
    }
    return { botId, applicationId: bot.applicationId, token };
  });
}
