import { Client, GatewayIntentBits, Partials } from "discord.js";
import { loadDiscordConfig } from "../config/config.js";
import type { GroupConfig } from "../config/groups.js";
import { findGroupByName } from "../config/groups.js";

export const DEFAULT_DISCORD_BOT_ID = "personal";

export function createDiscordClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });
}

const clients = new Map<string, Client>();

export async function initDiscordClients(
  loadConfig: () => Promise<Awaited<ReturnType<typeof loadDiscordConfig>>> = loadDiscordConfig,
): Promise<void> {
  const config = await loadConfig();
  for (const existing of clients.values()) existing.destroy();
  clients.clear();
  clients.set(DEFAULT_DISCORD_BOT_ID, createDiscordClient());
  for (const [botId] of Object.entries(config.bots)) {
    if (botId === DEFAULT_DISCORD_BOT_ID) {
      throw new Error(
        `Discord Bot ID は予約されています: ${DEFAULT_DISCORD_BOT_ID}`,
      );
    }
    clients.set(botId, createDiscordClient());
  }
}

export function getDiscordClient(botId: string): Client {
  const value = clients.get(botId);
  if (!value) throw new Error(`Discord Bot が未定義です: ${botId}`);
  return value;
}

export function getDefaultDiscordClient(): Client {
  return getDiscordClient(DEFAULT_DISCORD_BOT_ID);
}

export function getDiscordClients(): ReadonlyMap<string, Client> {
  return clients;
}

export function getDiscordClientForGroup(
  group: Pick<GroupConfig, "name" | "bot">,
): Client {
  return group.bot ? getDiscordClient(group.bot) : getDefaultDiscordClient();
}

export async function getDiscordClientForGroupName(
  groupName: string,
  findGroup: typeof findGroupByName = findGroupByName,
): Promise<Client> {
  const group = await findGroup(groupName);
  if (!group) throw new Error(`グループが未定義です: ${groupName}`);
  return getDiscordClientForGroup(group);
}

export async function loginDiscordClients(): Promise<void> {
  const config = await loadDiscordConfig();
  await Promise.all([
    getDefaultDiscordClient().login(process.env.DISCORD_BOT_TOKEN),
    ...Object.entries(config.bots).map(([botId, bot]) =>
      getDiscordClient(botId).login(process.env[bot.tokenEnv]),
    ),
  ]);
}

export async function destroyDiscordClients(): Promise<void> {
  for (const value of clients.values()) value.destroy();
  clients.clear();
}
