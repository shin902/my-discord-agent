import { randomUUID } from "node:crypto";
import type { BotTaskSession } from "./repository.js";

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
