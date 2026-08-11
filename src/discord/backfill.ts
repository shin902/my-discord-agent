import {
  type AnyThreadChannel,
  type Channel,
  ChannelType,
  type ForumChannel,
  type Message,
  type NewsChannel,
  type TextChannel,
} from "discord.js";
import type { ChannelConfig, GroupConfig } from "../config/groups.js";
import {
  getQueueRepository,
  type QueueRepository,
} from "../queue/repository.js";
import { client } from "./client.js";
import { ingestDiscordMessage } from "./intake.js";

const DISCORD_MESSAGE_PAGE_SIZE = 100;
// A synthetic snowflake at Discord's epoch is a valid lower bound for every
// message ID Discord can issue, so an empty scope can resume from its first
// message without treating the current tip as an initialization cursor.
const EMPTY_SCOPE_AFTER_MESSAGE_ID = "5956206959001600000";

type RootChannel = TextChannel | NewsChannel | ForumChannel;
type MessageChannel = TextChannel | NewsChannel | AnyThreadChannel;

interface BackfillTarget {
  group: GroupConfig;
  channel: ChannelConfig;
}

/** Recover Discord messages that arrived while the gateway was disconnected. */
export async function backfillDiscordMessages(
  groups: readonly GroupConfig[],
  repo: QueueRepository = getQueueRepository(),
): Promise<void> {
  logStartupBackfillStatus(groups);
  const targets = collectTargets(groups);
  for (const target of targets) {
    try {
      await backfillTarget(target, repo);
    } catch (error) {
      // A single inaccessible channel must not prevent other configured
      // channels from recovering their histories.
      console.error(
        `[discord-backfill] チャンネル ${target.channel.channelId} の復旧に失敗しました:`,
        error,
      );
    }
  }
}

function logStartupBackfillStatus(groups: readonly GroupConfig[]): void {
  for (const group of groups) {
    for (const channel of group.channels) {
      console.log(
        `[discord-backfill] channel=${channel.channelId} group=${group.name} startupBackfill.enabled=true source=default`,
      );
    }
  }
}

function collectTargets(groups: readonly GroupConfig[]): BackfillTarget[] {
  const targets = new Map<string, BackfillTarget>();
  for (const group of groups) {
    for (const channel of group.channels) {
      if (!targets.has(channel.channelId))
        targets.set(channel.channelId, { group, channel });
    }
  }
  return [...targets.values()];
}

async function backfillTarget(
  target: BackfillTarget,
  repo: QueueRepository,
): Promise<void> {
  const root = await client.channels.fetch(target.channel.channelId);
  if (!isRootChannel(root)) {
    console.warn(
      `[discord-backfill] 対象チャンネルを取得できないか、履歴復旧に対応していません: ${target.channel.channelId}`,
    );
    return;
  }

  if (isForumChannel(root)) {
    if (target.channel.sessionMode === "shared") return;

    const threads = await fetchThreads(root);
    await backfillForumThreads(threads, repo);
    return;
  }

  const rootCursor = await ensureRootCursor(root, repo);
  const shouldReplayRoot =
    target.channel.sessionMode !== "thread" &&
    target.channel.sessionMode !== "email-mode";

  if (shouldReplayRoot && rootCursor && isMessageChannel(root)) {
    await recoverMessages(root, rootCursor, repo);
  }

  if (target.channel.sessionMode === "shared") return;

  const threads = await fetchThreads(root);
  const threadFallbackCursor = repo.getDiscordCursor(root.id);
  for (const thread of threads) {
    const threadCursor =
      repo.getDiscordCursor(thread.id) ?? threadFallbackCursor;
    if (!threadCursor) continue;
    await recoverMessages(thread, threadCursor, repo);
  }
}

async function backfillForumThreads(
  threads: readonly AnyThreadChannel[],
  repo: QueueRepository,
): Promise<void> {
  for (const thread of threads) {
    const threadCursor = await ensureForumThreadCursor(thread, repo);
    if (threadCursor) await recoverMessages(thread, threadCursor, repo);
  }
}

async function ensureForumThreadCursor(
  thread: AnyThreadChannel,
  repo: QueueRepository,
): Promise<string | undefined> {
  const existing = repo.getDiscordCursor(thread.id);
  if (existing) return existing;
  if (repo.isDiscordCursorInitialized(thread.id))
    return EMPTY_SCOPE_AFTER_MESSAGE_ID;

  const latest = await thread.messages.fetch({ limit: 1, cache: false });
  const latestMessage = latest.first();
  if (!latestMessage) {
    repo.initializeDiscordCursor(thread.id);
    return undefined;
  }

  repo.upsertDiscordCursor(thread.id, latestMessage.id);
  return latestMessage.id;
}

async function ensureRootCursor(
  root: RootChannel,
  repo: QueueRepository,
): Promise<string | undefined> {
  const existing = repo.getDiscordCursor(root.id);
  if (existing) return existing;

  // An initialized scope with no message cursor was previously observed to be
  // empty. Do not probe the current tip and seed from it: messages posted after
  // that empty observation must remain eligible for backfill.
  if (repo.isDiscordCursorInitialized(root.id)) {
    return isMessageChannel(root) ? EMPTY_SCOPE_AFTER_MESSAGE_ID : undefined;
  }

  if (!isMessageChannel(root)) return undefined;
  const latest = await root.messages.fetch({ limit: 1, cache: false });
  const latestMessage = latest.first();
  if (!latestMessage) {
    repo.initializeDiscordCursor(root.id);
    return undefined;
  }

  // On the first deployment there is no reliable way to distinguish old
  // history from the downtime period, so seed at the current tip.
  repo.upsertDiscordCursor(root.id, latestMessage.id);
  return latestMessage.id;
}

async function recoverMessages(
  channel: MessageChannel,
  afterMessageId: string,
  repo: QueueRepository,
): Promise<void> {
  let cursor = afterMessageId;
  while (true) {
    const fetched = await channel.messages.fetch({
      after: cursor,
      limit: DISCORD_MESSAGE_PAGE_SIZE,
      cache: false,
    });
    if (fetched.size === 0) return;

    const messages = [...fetched.values()].sort(compareMessagesAscending);
    for (const message of messages) {
      const result = await ingestDiscordMessage(message, {
        source: "backfill",
        replyOnFailure: false,
      });
      const scope = result.cursorScope ?? channel.id;
      repo.upsertDiscordCursor(scope, message.id);
      cursor = message.id;
    }

    const lastMessage = messages.at(-1);
    if (!lastMessage || fetched.size < DISCORD_MESSAGE_PAGE_SIZE) return;
    cursor = lastMessage.id;
  }
}

async function fetchThreads(
  root: RootChannel,
): Promise<AnyThreadChannel[]> {
  const threads = new Map<string, AnyThreadChannel>();
  try {
    const active = await root.threads.fetchActive(false);
    for (const thread of active.threads.values())
      threads.set(thread.id, thread);
  } catch (error) {
    console.warn(
      `[discord-backfill] active threadの取得に失敗しました:`,
      error,
    );
  }

  const archivedTypes =
    root.type === ChannelType.GuildText
      ? (["public", "private"] as const)
      : (["public"] as const);
  for (const type of archivedTypes) {
    try {
      const archived = await root.threads.fetchArchived(
        { type, fetchAll: type === "public" },
        false,
      );
      for (const thread of archived.threads.values())
        threads.set(thread.id, thread);
    } catch (error) {
      if (type === "private" && isMissingAccessError(error)) {
        console.warn(
          `[discord-backfill] private archived threadの取得権限がありません: channel=${root.id}`,
        );
        continue;
      }
      console.warn(
        `[discord-backfill] ${type} archived threadの取得に失敗しました:`,
        error,
      );
    }
  }
  return [...threads.values()];
}

function isMissingAccessError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === 50001
  );
}

function compareMessagesAscending(
  left: Pick<Message, "id" | "createdTimestamp">,
  right: Pick<Message, "id" | "createdTimestamp">,
): number {
  if (left.createdTimestamp !== right.createdTimestamp)
    return left.createdTimestamp - right.createdTimestamp;
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function isRootChannel(channel: Channel | null): channel is RootChannel {
  return (
    channel?.type === ChannelType.GuildText ||
    channel?.type === ChannelType.GuildAnnouncement ||
    channel?.type === ChannelType.GuildForum
  );
}

function isForumChannel(channel: RootChannel): channel is ForumChannel {
  return channel.type === ChannelType.GuildForum;
}

function isMessageChannel(
  channel: RootChannel,
): channel is TextChannel | NewsChannel {
  return (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement
  );
}
