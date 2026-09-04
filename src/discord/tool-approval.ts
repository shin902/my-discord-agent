import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
} from "discord.js";
import {
  configureToolApprovalPresenter,
  decideToolApproval,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from "../application/tool-approval-service.js";
import { DEFAULT_DISCORD_BOT_ID } from "../config/constants.js";
import { findGroupByName } from "../config/groups.js";
import { getDiscordClient } from "./client.js";

const CUSTOM_ID_PREFIX = "tool-approval";
const DISCORD_CONTENT_LIMIT = 2_000;

function customId(requestId: string, decision: ToolApprovalDecision): string {
  return `${CUSTOM_ID_PREFIX}:${decision}:${requestId}`;
}

function buttons(requestId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(customId(requestId, "approve"))
      .setLabel("Approve")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(customId(requestId, "deny"))
      .setLabel("Deny")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
  );
}

function oneLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1)}…`;
}

function invocationBlock(invocation: string): string {
  const longestFence = Math.max(
    2,
    ...Array.from(invocation.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(longestFence + 1);
  return `Invocation (canonical normalized JSON):\n${fence}json\n${invocation}\n${fence}`;
}

function approvalMessage(request: ToolApprovalRequest): {
  content: string;
  files?: [{ attachment: Buffer; name: string }];
} {
  const baseLines = [
    "Privileged operation approval required",
    `Operation: ${oneLine(request.operation, 100)}`,
    `Target: ${oneLine(request.target, 300)}`,
    invocationBlock(request.invocation),
    `Expires: <t:${Math.floor(request.expiresAt / 1000)}:R>`,
  ];
  const baseContent = baseLines.join("\n");
  if (baseContent.length <= DISCORD_CONTENT_LIMIT) {
    const detailsPrefix = "\nDetails: ";
    const remaining = DISCORD_CONTENT_LIMIT - baseContent.length;
    if (remaining > detailsPrefix.length) {
      const details = oneLine(
        request.summary,
        remaining - detailsPrefix.length,
      );
      return { content: `${baseContent}${detailsPrefix}${details}` };
    }
    return { content: baseContent };
  }

  return {
    content: [
      "Privileged operation approval required",
      `Operation: ${oneLine(request.operation, 100)}`,
      `Target: ${oneLine(request.target, 300)}`,
      "Complete canonical normalized invocation attached as approval-request.json.",
      `Details: ${oneLine(request.summary, 400)}`,
      `Expires: <t:${Math.floor(request.expiresAt / 1000)}:R>`,
    ].join("\n"),
    files: [
      {
        attachment: Buffer.from(request.invocation, "utf8"),
        name: "approval-request.json",
      },
    ],
  };
}

async function presentDiscordToolApproval(request: ToolApprovalRequest) {
  const group = await findGroupByName(request.groupName);
  if (!group?.approvalUserIds?.length)
    throw new Error("Tool approval users are not configured");
  const discordBotId = group.bot ?? DEFAULT_DISCORD_BOT_ID;
  const client = getDiscordClient(discordBotId);
  const channel = await client.channels.fetch(request.channelId);
  if (!channel?.isSendable())
    throw new Error("Tool approval destination is not sendable");

  const message = await channel.send({
    ...approvalMessage(request),
    components: [buttons(request.requestId)],
    allowedMentions: { parse: [] },
  });
  if (message.channelId !== request.channelId)
    throw new Error("Tool approval destination changed");
  return {
    discordBotId,
    channelId: message.channelId,
    messageId: message.id,
    authorizedUserIds: group.approvalUserIds,
  };
}

/** Connect the application approval service to the Discord control surface. */
export function initializeDiscordToolApproval(): void {
  configureToolApprovalPresenter(presentDiscordToolApproval);
}

function parseCustomId(
  value: string,
): { requestId: string; decision: ToolApprovalDecision } | undefined {
  const match = /^tool-approval:(approve|deny):([A-Za-z0-9_-]{32})$/.exec(
    value,
  );
  if (!match?.[1] || !match[2]) return undefined;
  return {
    decision: match[1] as ToolApprovalDecision,
    requestId: match[2],
  };
}

/** Apply a human Discord button decision without accepting approval from tool input. */
export async function handleToolApprovalButton(
  interaction: ButtonInteraction,
  discordBotId: string,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return false;
  if (interaction.user.bot) {
    await interaction.reply({
      content: "Bot cannot approve privileged operations.",
      ephemeral: true,
    });
    return true;
  }

  const result = decideToolApproval({
    ...parsed,
    discordBotId,
    channelId: interaction.channelId,
    messageId: interaction.message.id,
    userId: interaction.user.id,
  });
  if (result === "unauthorized") {
    await interaction.reply({
      content: "You are not authorized for this approval request.",
      ephemeral: true,
    });
    return true;
  }
  const status =
    result === "approved"
      ? `Approved by ${interaction.user.username}.`
      : result === "denied"
        ? `Denied by ${interaction.user.username}.`
        : "This approval request is no longer valid.";
  await interaction.update({
    content: `${interaction.message.content}\n${status}`,
    components: [buttons(parsed.requestId, true)],
    allowedMentions: { parse: [] },
  });
  return true;
}
