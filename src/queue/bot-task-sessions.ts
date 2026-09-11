import { randomUUID } from "node:crypto";
import { appendMessage, loadMessages } from "../agent/session.js";
import { NonRetryableError } from "../utils/error.js";
import type {
  BotTaskSession,
  CreateBotTaskSessionInput,
} from "./repository.js";

/**
 * Persist the role before publishing a new task to the admission ledger.
 * The stores are separate: failed/duplicate admission may leave an unpublished
 * snapshot, but cannot expose a runnable task without its original role.
 */
export async function prepareBotTaskSession(
  input: Omit<CreateBotTaskSessionInput, "sessionId" | "handle">,
  instructions: string,
): Promise<CreateBotTaskSessionInput> {
  const session = {
    ...input,
    sessionId: generateBotTaskSessionId(),
    handle: generateBotTaskSessionHandle(),
  };
  await appendMessage(input.groupName, session.sessionId, {
    role: "custom",
    customType: "system-prompt-snapshot",
    content: instructions,
    display: false,
    timestamp: Date.parse(input.createdAt),
  });
  return session;
}

export async function loadBotTaskSystemPrompt(
  groupName: string,
  sessionId: string,
): Promise<string> {
  const messages = await loadMessages(groupName, sessionId);
  const snapshot = messages.find(
    (message) =>
      "customType" in message &&
      (message.customType === "system-prompt-snapshot" ||
        message.customType === "agents-snapshot"),
  );
  // Legacy snapshots may contain a Main/group role. There is no provenance
  // that distinguishes them from Bot roles: preserve them, never infer/rewrite.
  if (snapshot && "content" in snapshot) return String(snapshot.content ?? "");
  throw new NonRetryableError(
    "Task Sessionにsystem prompt snapshotがありません。新しいBot runでTask Sessionを作成してください。",
  );
}

export function generateBotTaskSessionId(): string {
  return `bot-task-${randomUUID()}`;
}

export function generateBotTaskSessionHandle(): string {
  return `task-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function previewBotTaskPrompt(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}

export function formatBotTaskSessionList(sessions: BotTaskSession[]): string {
  if (sessions.length === 0) return "利用可能なTask Sessionはありません。";
  const lines: string[] = [];
  for (const session of sessions) {
    const line = `- ${session.handle} | ${session.botId} | created: ${session.createdAt} | last-used: ${session.lastUsedAt} | ${session.preview}`;
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
