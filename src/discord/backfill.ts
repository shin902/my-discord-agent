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
import {
  beginDiscordChannelBackfill,
  finishDiscordChannelBackfill,
} from "./backfill-state.js";
import { getDiscordClientForGroup } from "./client.js";
import { ingestDiscordMessage } from "./intake.js";

const DISCORD_MESSAGE_PAGE_SIZE = 100;
// Use Discord's lower bound so an empty scope can resume from its first
// message without treating the current tip as an initialization cursor.
const EMPTY_SCOPE_AFTER_MESSAGE_ID = "0";

type RootChannel = TextChannel | NewsChannel | ForumChannel;
type MessageChannel = TextChannel | NewsChannel | AnyThreadChannel;

/** Recover Discord messages that arrived while the gateway was disconnected. */
export async function backfillDiscordMessages(
  groups: readonly GroupConfig[],
  repo: QueueRepository = getQueueRepository(),
): Promise<void> {
  // Live messages are still accepted while this function runs, but their
  // cursor updates must not move a channel that has not been scanned yet.
  // Register every channel before the sequential loop starts so a later
  // channel cannot be advanced by a live event during an earlier channel's
  // recovery.
  const channelIds = groups.flatMap((group) =>
    group.channels.map((channel) => channel.channelId),
  );
  beginDiscordChannelBackfill(channelIds);
  for (const group of groups) {
    const discordClient = getDiscordClientForGroup(group);
    for (const channel of group.channels) {
      try {
        const completed = await backfillTarget(discordClient, channel, repo);
        if (completed) finishDiscordChannelBackfill(channel.channelId);
      } catch (error) {
        // A single inaccessible channel must not prevent other configured
        // channels from recovering their histories. Keep its cursor gate in
        // place so live messages cannot skip the unscanned history.
        console.error(
          `[discord-backfill] チャンネル ${channel.channelId} の復旧に失敗しました:`,
          error,
        );
      }
    }
  }
}

async function backfillTarget(
  discordClient: import("discord.js").Client,
  channel: ChannelConfig,
  repo: QueueRepository,
): Promise<boolean> {
  const root = await discordClient.channels.fetch(channel.channelId);
  if (!isRootChannel(root)) {
    console.warn(
      `[discord-backfill] 対象チャンネルを取得できないか、履歴復旧に対応していません: ${channel.channelId}`,
    );
    return false;
  }

  if (isForumChannel(root)) {
    if (channel.sessionMode === "shared") return true;

    // Forum threads have no parent-channel message history to use as a
    // fallback cursor. Persist the first complete thread enumeration as the
    // forum's initialization boundary so a thread discovered on a later run
    // is known to be new, while threads already present at initialization
    // retain the initial-history behavior of starting at their current tip.
    const forumWasInitialized = repo.isDiscordCursorInitialized(root.id);
    const { threads, complete } = await fetchThreads(root);
    const seededCursors = forumWasInitialized
      ? undefined
      : await seedForumThreadCursors(threads, repo);
    if (!forumWasInitialized && complete) {
      // Persist the forum boundary before recovery. A recovery failure must
      // not make a thread discovered on the next run look pre-existing.
      repo.initializeDiscordCursor(root.id);
    }
    await backfillForumThreads(
      threads,
      repo,
      forumWasInitialized,
      seededCursors,
    );
    return complete;
  }

  const rootCursor = await ensureRootCursor(root, repo);
  const shouldReplayRoot =
    channel.sessionMode !== "thread" && channel.sessionMode !== "email-mode";

  if (shouldReplayRoot && rootCursor && isMessageChannel(root)) {
    await recoverMessages(root, rootCursor, repo);
  }

  if (channel.sessionMode === "shared") return true;

  const { threads, complete } = await fetchThreads(root);
  const threadFallbackCursor = rootCursor;
  for (const thread of threads) {
    const threadCursor =
      repo.getDiscordCursor(thread.id) ?? threadFallbackCursor;
    if (!threadCursor) continue;
    await recoverMessages(thread, threadCursor, repo);
  }
  return complete;
}

async function seedForumThreadCursors(
  threads: readonly AnyThreadChannel[],
  repo: QueueRepository,
): Promise<Map<string, string | undefined>> {
  const cursors = new Map<string, string | undefined>();
  for (const thread of threads) {
    cursors.set(thread.id, await ensureForumThreadCursor(thread, repo, false));
  }
  return cursors;
}

async function backfillForumThreads(
  threads: readonly AnyThreadChannel[],
  repo: QueueRepository,
  forumWasInitialized: boolean,
  seededCursors?: ReadonlyMap<string, string | undefined>,
): Promise<void> {
  for (const thread of threads) {
    const threadCursor = seededCursors?.has(thread.id)
      ? seededCursors.get(thread.id)
      : await ensureForumThreadCursor(thread, repo, forumWasInitialized);
    if (threadCursor) await recoverMessages(thread, threadCursor, repo);
  }
}

async function ensureForumThreadCursor(
  thread: AnyThreadChannel,
  repo: QueueRepository,
  forumWasInitialized: boolean,
): Promise<string | undefined> {
  const existing = repo.getDiscordCursor(thread.id);
  if (existing) return existing;
  if (repo.isDiscordCursorInitialized(thread.id))
    return EMPTY_SCOPE_AFTER_MESSAGE_ID;

  // A thread first enumerated after the forum boundary was persisted is new
  // to the backfill. Start at Discord's lower bound so its post and any
  // replies that arrived during downtime are replayed.
  if (forumWasInitialized) return EMPTY_SCOPE_AFTER_MESSAGE_ID;

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

interface ThreadFetchResult {
  threads: AnyThreadChannel[];
  complete: boolean;
}

async function fetchThreads(root: RootChannel): Promise<ThreadFetchResult> {
  const threads = new Map<string, AnyThreadChannel>();
  try {
    const active = await root.threads.fetchActive(false);
    for (const thread of active.threads.values())
      threads.set(thread.id, thread);
    return { threads: [...threads.values()], complete: true };
  } catch (error) {
    console.warn(
      `[discord-backfill] active threadの取得に失敗しました:`,
      error,
    );
    return { threads: [...threads.values()], complete: false };
  }
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
