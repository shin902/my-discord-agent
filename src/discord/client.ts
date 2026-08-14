import { Client, GatewayIntentBits, Partials } from "discord.js";
import { loadDiscordConfig } from "../config/config.js";
import { findGroupByChannelId } from "../config/groups.js";

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
// Backward-compatible default export for cron integrations and consumers that
// do not perform channel I/O. Runtime Discord I/O uses the registry helpers.
export const client = createDiscordClient();

let defaultBot: string | undefined;

export async function initDiscordClients(): Promise<void> {
  const config = await loadDiscordConfig();
  for (const existing of clients.values()) existing.destroy();
  clients.clear();
  defaultBot = config.defaultBot;
  for (const [botId] of Object.entries(config.bots)) {
    clients.set(botId, createDiscordClient());
  }
}

export function getDiscordClient(botId: string): Client {
  const value = clients.get(botId);
  if (!value) throw new Error(`Discord Bot が未定義です: ${botId}`);
  return value;
}

export function getDiscordClients(): ReadonlyMap<string, Client> {
  return clients;
}

export function getDefaultDiscordBot(): string {
  if (!defaultBot) throw new Error("Discord Client が初期化されていません");
  return defaultBot;
}

function parentChannelId(channel: unknown): string | undefined {
  if (!channel || typeof channel !== "object") return undefined;
  const parentId = (channel as { parentId?: unknown }).parentId;
  return typeof parentId === "string" ? parentId : undefined;
}

async function findDiscordClientForThread(
  channelId: string,
): Promise<Client | undefined> {
  // A live event or a startup backfill normally leaves the thread in the
  // receiving client's cache. Resolve from its parent without an API call.
  for (const discordClient of clients.values()) {
    const cached = discordClient.channels.cache.get(channelId);
    const parentId = parentChannelId(cached);
    if (!parentId) continue;
    const resolved = await findGroupByChannelId(parentId);
    if (resolved) {
      return getDiscordClient(resolved.group.bot ?? getDefaultDiscordBot());
    }
  }

  // Caches are empty after a restart, so fetch the thread metadata from each
  // connected client. Fetching the thread is safe and does not mutate Discord;
  // an inaccessible channel simply means this client cannot resolve it.
  for (const discordClient of clients.values()) {
    const fetched = await discordClient.channels
      .fetch(channelId)
      .catch(() => null);
    const parentId = parentChannelId(fetched);
    if (!parentId) continue;
    const resolved = await findGroupByChannelId(parentId);
    if (resolved) {
      return getDiscordClient(resolved.group.bot ?? getDefaultDiscordBot());
    }
  }

  return undefined;
}

export async function getDiscordClientForChannel(
  channelId: string,
): Promise<Client> {
  const resolved = await findGroupByChannelId(channelId);
  if (resolved)
    return getDiscordClient(resolved.group.bot ?? getDefaultDiscordBot());

  const threadClient = await findDiscordClientForThread(channelId);
  return threadClient ?? getDiscordClient(getDefaultDiscordBot());
}

export async function loginDiscordClients(): Promise<void> {
  const config = await loadDiscordConfig();
  await Promise.all(
    Object.entries(config.bots).map(([botId, bot]) =>
      getDiscordClient(botId).login(process.env[bot.tokenEnv]),
    ),
  );
}

export async function destroyDiscordClients(): Promise<void> {
  for (const value of clients.values()) value.destroy();
  clients.clear();
  defaultBot = undefined;
}
