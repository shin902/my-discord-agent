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
import type { ToolApprovalRequest } from "../proxy/tool-approval.js";
import { getDiscordClient } from "./client.js";

const CUSTOM_ID_PREFIX = "tool-approval";
const MESSAGE_LIMIT = 2_000;
const ARGS_FILE = "tool-approval-args.json";
const TERMINAL_RESULT_SUFFIX = "\nResult: Approved";
type ToolApprovalDecision = "approve" | "deny";
export const TOOL_APPROVAL_UPDATE_TIMEOUT_MS = 5_000;

type PendingApproval = {
  request: ToolApprovalRequest;
  botId: string;
  channelId: string;
  messageId: string;
  requestId: string;
  inline: boolean;
};

const pending = new Map<string, PendingApproval>();

function customId(requestId: string, decision: ToolApprovalDecision): string {
  return `${CUSTOM_ID_PREFIX}:${requestId}:${decision}`;
}

function buttons(requestId: string, disabled: boolean) {
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

function content(request: ToolApprovalRequest, inline: boolean): string {
  const header = `Tool approval required\nTool: ${request.invocation.capability}`;
  return inline
    ? `${header}\nArguments:\n\`\`\`json\n${request.invocation.args.json}\n\`\`\``
    : `${header}\nArguments: attached as ${ARGS_FILE}`;
}

function inlineArgs(request: ToolApprovalRequest): boolean {
  if (request.invocation.args.json.includes("```")) return false;
  return (
    content(request, true).length + TERMINAL_RESULT_SUFFIX.length <=
    MESSAGE_LIMIT
  );
}

function initialPayload(
  request: ToolApprovalRequest,
  requestId: string,
  inline: boolean,
): MessageCreateOptions {
  return {
    content: content(request, inline),
    components: buttons(requestId, false),
    allowedMentions: { parse: [], repliedUser: false },
    ...(inline
      ? {}
      : {
          files: [
            {
              attachment: Buffer.from(request.invocation.args.json, "utf8"),
              name: ARGS_FILE,
            },
          ],
        }),
  };
}

function terminalPayload(
  item: PendingApproval,
  decision: ToolApprovalDecision,
): InteractionUpdateOptions {
  return {
    content: `${content(item.request, item.inline)}\nResult: ${
      decision === "approve" ? "Approved" : "Denied"
    }`,
    components: buttons(item.requestId, true),
    allowedMentions: { parse: [], repliedUser: false },
  };
}

function parseCustomId(value: string) {
  const parts = value.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== CUSTOM_ID_PREFIX ||
    !parts[1] ||
    (parts[2] !== "approve" && parts[2] !== "deny")
  ) {
    return undefined;
  }
  return { requestId: parts[1], decision: parts[2] as ToolApprovalDecision };
}

function sendable(
  channel: unknown,
): channel is { send(options: MessageCreateOptions): Promise<Message> } {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof channel.send === "function"
  );
}

export async function presentToolApprovalRequest(
  request: ToolApprovalRequest,
): Promise<void> {
  const { botId, channelId } = request.invocation.trustedDiscordDestination;
  const channel = await getDiscordClient(botId).channels.fetch(channelId);
  if (!sendable(channel))
    throw new Error(`Discord channel is not sendable: ${channelId}`);

  const requestId = randomUUID();
  const inline = inlineArgs(request);
  const message = await channel.send(
    initialPayload(request, requestId, inline),
  );
  pending.set(requestId, {
    request,
    botId,
    channelId,
    messageId: message.id,
    requestId,
    inline,
  });
  void request.waitForDecision().then(
    () => pending.delete(requestId),
    () => pending.delete(requestId),
  );
}

function updateWithTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Discord tool approval update timed out")),
      TOOL_APPROVAL_UPDATE_TIMEOUT_MS,
    );
  });
  return Promise.race([operation, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

export async function routeToolApprovalInteraction(
  interaction: ButtonInteraction,
  discordBotId: string,
): Promise<boolean> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return false;
  const item = pending.get(parsed.requestId);
  if (
    !item ||
    interaction.user.bot ||
    item.botId !== discordBotId ||
    item.channelId !== interaction.channelId ||
    item.messageId !== interaction.message.id
  ) {
    return false;
  }

  const claim = item.request.claim(parsed.decision);
  if (!claim) return false;
  try {
    await updateWithTimeout(
      interaction.update(terminalPayload(item, parsed.decision)),
    );
    claim.completeUiUpdate();
  } catch (error) {
    claim.failUiUpdate(error);
  } finally {
    pending.delete(parsed.requestId);
  }
  return true;
}
