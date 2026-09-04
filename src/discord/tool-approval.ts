import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  type InteractionUpdateOptions,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type {
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "../proxy/tool-approval.js";
import { getDiscordClient } from "./client.js";

const APPROVAL_CUSTOM_ID_PREFIX = "tool-approval";
const DISCORD_MESSAGE_LIMIT = 2_000;
const ARGS_ATTACHMENT_NAME = "tool-approval-args.json";
const APPROVED_RESULT_SUFFIX = "\nResult: Approved";
export const TOOL_APPROVAL_UPDATE_TIMEOUT_MS = 5_000;

interface PendingDiscordApproval {
  readonly request: ToolApprovalRequest;
  readonly botId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly requestId: string;
  readonly argsInline: boolean;
}

const pendingApprovals = new Map<string, PendingDiscordApproval>();

function customId(requestId: string, decision: ToolApprovalDecision): string {
  return `${APPROVAL_CUSTOM_ID_PREFIX}:${requestId}:${decision}`;
}

function approvalButtons(
  requestId: string,
  disabled: boolean,
): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
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
    ),
  ];
}

function baseContent(
  request: ToolApprovalRequest,
  argsInline: boolean,
): string {
  const header = `Tool approval required\nTool: ${request.invocation.capability}`;
  if (!argsInline) {
    return `${header}\nArguments: attached as ${ARGS_ATTACHMENT_NAME}`;
  }
  return `${header}\nArguments:\n\`\`\`json\n${request.invocation.args.json}\n\`\`\``;
}

function shouldInlineArgs(request: ToolApprovalRequest): boolean {
  if (request.invocation.args.json.includes("```")) return false;
  return (
    baseContent(request, true).length + APPROVED_RESULT_SUFFIX.length <=
    DISCORD_MESSAGE_LIMIT
  );
}

function initialPayload(
  request: ToolApprovalRequest,
  requestId: string,
  argsInline: boolean,
): MessageCreateOptions {
  return {
    content: baseContent(request, argsInline),
    components: approvalButtons(requestId, false),
    allowedMentions: { parse: [], repliedUser: false },
    ...(argsInline
      ? {}
      : {
          files: [
            {
              attachment: Buffer.from(request.invocation.args.json, "utf8"),
              name: ARGS_ATTACHMENT_NAME,
            },
          ],
        }),
  };
}

function terminalPayload(
  pending: PendingDiscordApproval,
  decision: ToolApprovalDecision,
): InteractionUpdateOptions {
  const resultSuffix =
    decision === "approve" ? APPROVED_RESULT_SUFFIX : "\nResult: Denied";
  return {
    content: `${baseContent(pending.request, pending.argsInline)}${resultSuffix}`,
    components: approvalButtons(pending.requestId, true),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

function parseApprovalCustomId(
  value: string,
): { requestId: string; decision: ToolApprovalDecision } | undefined {
  const parts = value.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== APPROVAL_CUSTOM_ID_PREFIX ||
    !parts[1] ||
    (parts[2] !== "approve" && parts[2] !== "deny")
  ) {
    return undefined;
  }
  return { requestId: parts[1], decision: parts[2] };
}

function canSendMessages(
  channel: unknown,
): channel is { send(options: MessageCreateOptions): Promise<Message> } {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof channel.send === "function"
  );
}

function observeSettlement(pending: PendingDiscordApproval): void {
  void pending.request.waitForDecision().then(
    () => pendingApprovals.delete(pending.requestId),
    () => pendingApprovals.delete(pending.requestId),
  );
}

/** Present one generic approval request in its snapshotted Discord destination. */
export async function presentToolApprovalRequest(
  request: ToolApprovalRequest,
): Promise<void> {
  const { botId, channelId } = request.invocation.destination;
  const client = getDiscordClient(botId);
  const channel = await client.channels.fetch(channelId);
  if (!canSendMessages(channel)) {
    throw new Error(
      `Tool approval Discord channel is not sendable: ${channelId}`,
    );
  }

  const requestId = randomUUID();
  const argsInline = shouldInlineArgs(request);
  const message = await channel.send(
    initialPayload(request, requestId, argsInline),
  );
  const pending = {
    request,
    botId,
    channelId,
    messageId: message.id,
    requestId,
    argsInline,
  } satisfies PendingDiscordApproval;
  pendingApprovals.set(requestId, pending);
  observeSettlement(pending);
}

function withUpdateTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Discord tool approval update timed out")),
      TOOL_APPROVAL_UPDATE_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Route a matching approval button; unrelated component interactions are ignored. */
export async function routeToolApprovalInteraction(
  interaction: ButtonInteraction,
  discordBotId: string,
): Promise<boolean> {
  const parsed = parseApprovalCustomId(interaction.customId);
  if (!parsed) return false;

  const pending = pendingApprovals.get(parsed.requestId);
  if (
    !pending ||
    interaction.user.bot ||
    pending.botId !== discordBotId ||
    pending.channelId !== interaction.channelId ||
    pending.messageId !== interaction.message.id
  ) {
    return false;
  }

  const claim = pending.request.claim(parsed.decision);
  if (!claim) return false;

  try {
    await withUpdateTimeout(
      interaction.update(terminalPayload(pending, parsed.decision)),
    );
    claim.completeUiUpdate();
  } catch (error) {
    claim.failUiUpdate(error);
  } finally {
    pendingApprovals.delete(parsed.requestId);
  }
  return true;
}
