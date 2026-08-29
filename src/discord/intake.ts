import {
  type Message,
  MessageType,
  ThreadAutoArchiveDuration,
} from "discord.js";
import { pickAgentConfig } from "../config/agent-resolution.js";
import { findGroupByChannelId } from "../config/groups.js";
import { getQueueRepository } from "../queue/repository.js";
import type { QueueInput } from "../queue/types.js";
import { isDiscordChannelBackfillPending } from "./backfill-state.js";

export type DiscordMessageSource = "live" | "backfill";

export interface DiscordIngestResult {
  status: "enqueued" | "ignored";
  cursorScope?: string;
}

interface IngestOptions {
  source: DiscordMessageSource;
  replyOnFailure: boolean;
  updateLiveCursor?: boolean;
}

export async function handleLiveDiscordMessage(
  message: Message,
): Promise<DiscordIngestResult> {
  return ingestDiscordMessage(message, {
    source: "live",
    replyOnFailure: true,
  });
}

export async function ingestDiscordMessage(
  message: Message,
  options: { source: DiscordMessageSource; replyOnFailure?: boolean },
): Promise<DiscordIngestResult> {
  return ingest(message, {
    source: options.source,
    replyOnFailure: options.replyOnFailure ?? false,
    updateLiveCursor: options.source === "live",
  });
}

// URL あり → "{hostname}-{messageId末尾6文字}", URL なし → "thread-{messageId末尾6文字}", 最大100文字
function buildThreadName(content: string, messageId: string): string {
  const suffix = messageId.slice(-6);
  const urlMatch = /https?:\/\/[^\s<>()]+/iu.exec(content);
  if (urlMatch) {
    try {
      const hostname = new URL(urlMatch[0]).hostname.replace(/\./g, "-");
      return `${hostname}-${suffix}`.slice(0, 100);
    } catch {
      // URL パースに失敗したら fallthrough
    }
  }
  return `thread-${suffix}`;
}

function mentionsCurrentDiscordBot(message: Message): boolean {
  const botUserId = message.client.user?.id;
  return botUserId !== undefined && message.mentions.users.has(botUserId);
}

class ThreadCreationError extends Error {
  constructor(cause: unknown) {
    super("thread creation failed", { cause });
    this.name = "ThreadCreationError";
  }
}

async function ingest(
  message: Message,
  options: IngestOptions,
): Promise<DiscordIngestResult> {
  let channel = message.channel;
  if (channel.isThread() && !channel.parentId) {
    channel = await channel.fetch().catch(() => channel);
  }

  const isThread = channel.isThread();
  const parentId = isThread && "parentId" in channel ? channel.parentId : null;
  const lookupId = isThread && parentId ? parentId : message.channelId;
  const defaultCursorScope = isThread ? message.channelId : lookupId;
  const match = await findGroupByChannelId(lookupId);
  if (!match) return { status: "ignored" };

  // Historical backfill deliberately excludes bot/webhook messages so old RSS
  // webhook entries are not reintroduced into the normal agent queue.
  const isAllowedLiveBotMessage =
    !message.author.bot ||
    (message.webhookId !== null &&
      match.channel.allowedWebhookIds?.includes(message.webhookId) === true);
  if (
    !isAllowedLiveBotMessage ||
    (options.source === "backfill" && message.webhookId !== null)
  ) {
    return { status: "ignored", cursorScope: defaultCursorScope };
  }

  // ThreadCreated is a system record in the parent channel, not a user turn.
  if (message.type === MessageType.ThreadCreated && !isThread) {
    return { status: "ignored", cursorScope: defaultCursorScope };
  }

  // Thread messages resolve their parent channel before this point, so a
  // channel-level requiredMention policy applies equally to the channel and
  // every thread below it. Slash commands use InteractionCreate and bypass
  // this normal-message gate.
  if (
    match.channel.requiredMention === true &&
    !mentionsCurrentDiscordBot(message)
  ) {
    return { status: "ignored", cursorScope: defaultCursorScope };
  }

  let sessionId: string;
  let inboxChannelId = message.channelId;
  let replyMessageId: string | undefined = message.id;
  let cursorScope = defaultCursorScope;

  try {
    if (match.channel.sessionMode === "shared") {
      if (isThread) return { status: "ignored", cursorScope: lookupId };
      sessionId = message.channelId;
      cursorScope = message.channelId;
    } else if (match.channel.sessionMode === "thread") {
      if (!isThread) return { status: "ignored", cursorScope: lookupId };
      sessionId = message.channelId;
      cursorScope = message.channelId;
    } else if (match.channel.sessionMode === "auto-thread") {
      if (isThread) {
        sessionId = message.channelId;
        cursorScope = message.channelId;
      } else {
        const threadName = buildThreadName(message.content, message.id);
        const thread = await findOrCreateThread(message, threadName);
        sessionId = thread.id;
        inboxChannelId = thread.id;
        // The response is sent to the newly-created thread, so a parent
        // message ID must not be used as a cross-channel reply target.
        replyMessageId = undefined;
        cursorScope = message.channelId;
      }
    } else if (match.channel.sessionMode === "email-mode") {
      if (!isThread) return { status: "ignored", cursorScope: lookupId };
      sessionId = message.channelId;
      cursorScope = message.channelId;
    } else {
      const _: never = match.channel.sessionMode;
      return { status: "ignored", cursorScope: defaultCursorScope };
    }

    const attachments =
      message.attachments.size > 0
        ? [...message.attachments.values()].map((attachment) => ({
            url: attachment.url,
            name: attachment.name,
            contentType: attachment.contentType,
            size: attachment.size,
          }))
        : undefined;

    const channelConfigOverride = pickAgentConfig(match.channel);
    const payload: QueueInput = {
      channelId: inboxChannelId,
      groupName: match.group.name,
      sessionId,
      messageId: replyMessageId,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
      idempotencyKey: `discord-message:${message.id}`,
      attachments,
      ...(Object.keys(channelConfigOverride).length > 0
        ? { configOverride: channelConfigOverride }
        : {}),
    };

    const repository = getQueueRepository();
    await repository.enqueue(payload);
    if (
      options.updateLiveCursor &&
      !isDiscordChannelBackfillPending(lookupId) &&
      typeof repository.upsertDiscordCursor === "function"
    ) {
      repository.upsertDiscordCursor(cursorScope, message.id);
    }
    return { status: "enqueued", cursorScope };
  } catch (error) {
    if (error instanceof ThreadCreationError) {
      if (options.replyOnFailure) {
        await message
          .reply("スレッドの作成に失敗しました。もう一度送ってください。")
          .catch((replyError) =>
            console.error("[handler] reply 失敗:", replyError),
          );
        return { status: "ignored", cursorScope };
      }
      throw error;
    }

    if (options.replyOnFailure) {
      console.error("[handler] appendInbox 失敗:", error);
      await message
        .reply("メッセージの受信に失敗しました。もう一度送ってください。")
        .catch((replyError) =>
          console.error("[handler] reply 失敗:", replyError),
        );
      return { status: "ignored", cursorScope };
    }
    throw error;
  }
}

async function findOrCreateThread(
  message: Message,
  threadName: string,
): Promise<{ id: string }> {
  try {
    const existing =
      message.thread ?? (await message.fetch().catch(() => null))?.thread;
    if (existing) return existing;
    return await message.startThread({
      name: threadName,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });
  } catch (error) {
    // A timeout can mean Discord created the thread successfully. Re-fetch the
    // message before reporting a real failure, matching the live handler's
    // existing recovery behavior.
    const recovered =
      message.thread ?? (await message.fetch().catch(() => null))?.thread;
    if (recovered) return recovered;
    throw new ThreadCreationError(error);
  }
}
