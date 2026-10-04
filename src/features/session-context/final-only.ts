import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ConversationEntries } from "../../agent/conversation.js";
import { loadMessages, readSessionEntries } from "../../agent/session.js";
import { getQueueRepository } from "../../queue/repository.js";
import type { InboxMessage } from "../../queue/types.js";
import { publicCheckpointHistory } from "./compaction.js";

/** Select exact adopted finals, never infer them from adjacent raw messages. */
export function projectSessionContext(
  entries: ReadonlyMap<number, AgentMessage>,
  references: Iterable<ConversationEntries>,
): AssistantMessage[] {
  const finals = new Map<number, AssistantMessage>();
  for (const { userEntryId, assistantEntryId } of references) {
    const user = entries.get(userEntryId);
    const message = entries.get(assistantEntryId);
    if (
      user?.role !== "user" ||
      message?.role !== "assistant" ||
      message.errorMessage ||
      (message.stopReason !== "stop" && message.stopReason !== "length") ||
      message.content.some((block) => block.type === "toolCall")
    )
      continue;
    const content = message.content.filter((block) => block.type === "text");
    if (
      !content
        .map((block) => block.text)
        .join("")
        .trim()
    )
      continue;
    finals.set(assistantEntryId, { ...message, content });
  }
  return [...finals.values()];
}

export async function resolvePublicCompactionHistory(
  input: InboxMessage,
  agentId: string,
): Promise<AgentMessage[]> {
  const raw = await loadMessages(input.groupName, input.sessionId, agentId);
  return [
    ...publicCheckpointHistory(raw),
    ...(resolveSessionContext(
      { ...input, cronHistoryMode: "final-only" },
      agentId,
    ) ?? []),
  ];
}

/** Undefined preserves full history; [] explicitly removes prior run traces. */
export function resolveSessionContext(
  input: InboxMessage,
  agentId: string,
): AgentMessage[] | undefined {
  if (input.cronHistoryMode !== "final-only") return undefined;
  const references = [
    ...getQueueRepository().readCommittedConversations(input.groupName, {
      publicOnly: true,
    }),
  ];
  if (references.length === 0) return [];
  const entries = readSessionEntries(
    input.groupName,
    input.sessionId,
    agentId,
    references.flatMap(({ userEntryId, assistantEntryId }) => [
      userEntryId,
      assistantEntryId,
    ]),
  );
  return projectSessionContext(entries, references);
}
