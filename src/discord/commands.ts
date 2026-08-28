import { randomUUID } from "node:crypto";
import {
  ApplicationCommandType,
  type ChatInputCommandInteraction,
  type Client,
  SlashCommandBuilder,
} from "discord.js";
import { loadBotRegistry, resolveBotProfile } from "../config/bots.js";
import { findGroupByChannelId } from "../config/groups.js";
import type { BotTaskSession } from "../queue/repository.js";
import { getQueueRepository } from "../queue/repository.js";
import type { QueueInput } from "../queue/types.js";
import { DEFAULT_DISCORD_BOT_ID } from "./client.js";

export const BOT_COMMAND = new SlashCommandBuilder()
  .setName("bot")
  .setDescription("指定したBotへ依頼します")
  .addStringOption((option) =>
    option.setName("bot").setDescription("利用するBot ID").setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("action")
      .setDescription("run（新規）、resume（続き）、list（一覧）")
      .addChoices(
        { name: "run", value: "run" },
        { name: "resume", value: "resume" },
        { name: "list", value: "list" },
      ),
  )
  .addStringOption((option) =>
    option.setName("prompt").setDescription("Botへの依頼内容"),
  )
  .addStringOption((option) =>
    option.setName("session").setDescription("resumeするTask Session handle"),
  );

/** Synchronize the single command owned by this application. */
export async function synchronizeBotCommand(client: Client): Promise<void> {
  if (!client.application)
    throw new Error("Discord application が未初期化です");
  const command = BOT_COMMAND.toJSON();
  const existing = (await client.application.commands.fetch()).find(
    (registered) =>
      registered.name === command.name &&
      registered.type === ApplicationCommandType.ChatInput,
  );
  if (existing) {
    await client.application.commands.edit(existing.id, command);
  } else {
    await client.application.commands.create(command);
  }
}

export interface BotCommandSyncRetryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
}

/** Retry command registration briefly because ClientReady can precede API readiness. */
export async function synchronizeBotCommandWithRetry(
  client: Client,
  options: BotCommandSyncRetryOptions = {},
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 1_000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(
      `[discord-command] /bot 同期を試行します (${attempt}/${maxAttempts})`,
    );
    try {
      await synchronizeBotCommand(client);
      console.log(
        `[discord-command] /bot 同期に成功しました (${attempt}/${maxAttempts})`,
      );
      return;
    } catch (error) {
      lastError = error;
      console.error(
        `[discord-command] /bot 同期に失敗しました (${attempt}/${maxAttempts}):`,
        error,
      );
      if (attempt < maxAttempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

type InteractionChannel = {
  isThread?: () => boolean;
  parentId?: string | null;
  fetch?: () => Promise<unknown>;
};

async function interactionGroupLookupId(
  interaction: ChatInputCommandInteraction,
): Promise<string> {
  const channel = interaction.channel as InteractionChannel | null;
  if (channel?.isThread?.() === true) {
    let parentId = channel.parentId;
    if (!parentId && channel.fetch) {
      const fetched = await channel.fetch().catch(() => null);
      parentId = (fetched as InteractionChannel | null)?.parentId;
    }
    if (parentId) return parentId;
  }
  return interaction.channelId;
}

async function replyEphemeral(
  interaction: ChatInputCommandInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content });
  } else {
    await interaction.reply({ content, ephemeral: true });
  }
}

function taskSessionId(): string {
  return `bot-task-${randomUUID()}`;
}

function taskSessionHandle(): string {
  return `task-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function taskPreview(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}

function validSessionHandle(handle: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(handle);
}

function formatTaskSessionList(
  sessions: Array<{
    handle: string;
    botId: string;
    createdAt: string;
    lastUsedAt: string;
    channelId: string;
    preview: string;
  }>,
): string {
  if (sessions.length === 0) return "利用可能なTask Sessionはありません。";
  const lines: string[] = [];
  for (const session of sessions) {
    const line = `- ${session.handle} | ${session.botId} | created: ${session.createdAt} | last-used: ${session.lastUsedAt} | ${session.preview} (channel: ${session.channelId})`;
    if (
      `Task Session一覧（${sessions.length}件）:\n${[...lines, line].join("\n")}`
        .length > 1_800
    )
      break;
    lines.push(line);
  }
  const suffix =
    sessions.length > lines.length
      ? `\n（他${sessions.length - lines.length}件）`
      : "";
  return `Task Session一覧（${sessions.length}件）:\n${lines.join("\n")}${suffix}`;
}

/** Enqueue a Bot request while retaining the normal delivery path. */
export async function handleBotCommand(
  interaction: ChatInputCommandInteraction,
  discordBotId = DEFAULT_DISCORD_BOT_ID,
): Promise<void> {
  const botId = interaction.options.getString("bot", true);
  const action = interaction.options.getString("action") ?? "run";
  const prompt = interaction.options.getString("prompt")?.trim() ?? "";
  const handle = interaction.options.getString("session")?.trim() ?? "";

  const match = await findGroupByChannelId(
    await interactionGroupLookupId(interaction),
  );
  if (!match) {
    await replyEphemeral(
      interaction,
      "このチャンネルはAgentGroupに未登録です。",
    );
    return;
  }

  const expectedDiscordBotId = match.group.bot ?? DEFAULT_DISCORD_BOT_ID;
  if (discordBotId !== expectedDiscordBotId) {
    await replyEphemeral(
      interaction,
      "このDiscord BotはこのチャンネルのAgentGroupを担当していません。",
    );
    return;
  }

  try {
    const registry = await loadBotRegistry();
    resolveBotProfile(registry, botId, match.group.name);
  } catch (error) {
    await replyEphemeral(
      interaction,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  if (action !== "run" && action !== "resume" && action !== "list") {
    await replyEphemeral(
      interaction,
      "action は run、resume、list のいずれかです。",
    );
    return;
  }
  if (action === "list") {
    if (prompt || handle) {
      await replyEphemeral(
        interaction,
        "list では prompt と session は指定できません。",
      );
      return;
    }
    try {
      const sessions = getQueueRepository().listBotTaskSessions(
        match.group.name,
        botId,
      );
      await replyEphemeral(interaction, formatTaskSessionList(sessions));
    } catch (error) {
      await replyEphemeral(
        interaction,
        `Task Session一覧を取得できませんでした: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return;
  }
  if (!prompt) {
    await replyEphemeral(interaction, "prompt は必須です。");
    return;
  }
  if (action === "run" && handle) {
    await replyEphemeral(
      interaction,
      "新規実行では session を指定できません。resume を使用してください。",
    );
    return;
  }
  if (action === "resume" && !validSessionHandle(handle)) {
    await replyEphemeral(
      interaction,
      "不正または空のTask Session handleです。",
    );
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const repository = getQueueRepository();
    const now = new Date().toISOString();
    let session: BotTaskSession;
    if (action === "resume") {
      const found = repository.findBotTaskSession(
        handle,
        match.group.name,
        botId,
      );
      if (!found) {
        await interaction.editReply({
          content: "指定されたTask Sessionは見つかりません。",
        });
        return;
      }
      session = found;
      repository.touchBotTaskSession(
        session.sessionId,
        interaction.channelId,
        now,
      );
    } else {
      session = repository.createBotTaskSession({
        sessionId: taskSessionId(),
        handle: taskSessionHandle(),
        groupName: match.group.name,
        botId,
        channelId: interaction.channelId,
        sourceKey: `discord-interaction:${interaction.id}`,
        createdAt: now,
        preview: taskPreview(prompt),
      });
    }

    const payload: QueueInput = {
      channelId: interaction.channelId,
      groupName: match.group.name,
      // Task Session identity is deliberately independent from the delivery
      // channel/thread so Bot work never shares normal conversation history.
      sessionId: session.sessionId,
      content: prompt,
      timestamp: now,
      idempotencyKey: `discord-interaction:${interaction.id}`,
      botId,
    };
    await repository.enqueue(payload);
    await interaction.editReply({
      content: `Botへの依頼を受け付けました。Task Session: ${session.handle}`,
    });
  } catch (error) {
    await replyEphemeral(
      interaction,
      `Botへの依頼を受け付けられませんでした: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
