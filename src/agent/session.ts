import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const SESSIONS_DIR = path.join(process.cwd(), "data", "sessions");

function validateName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`不正な${label}: ${name}`);
  }
}

async function ensureDir(groupName: string): Promise<void> {
  await mkdir(path.join(SESSIONS_DIR, groupName), { recursive: true });
}

function sessionPath(groupName: string, sessionId: string): string {
  return path.join(SESSIONS_DIR, groupName, `${sessionId}.jsonl`);
}

export async function loadMessages(
  groupName: string,
  sessionId: string,
): Promise<AgentMessage[]> {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");

  const file = sessionPath(groupName, sessionId);
  if (!existsSync(file)) return [];

  const text = await readFile(file, "utf-8");
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AgentMessage);
}

export async function appendMessage(
  groupName: string,
  sessionId: string,
  message: AgentMessage,
): Promise<void> {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");

  await ensureDir(groupName);
  await appendFile(
    sessionPath(groupName, sessionId),
    `${JSON.stringify(message)}\n`,
    "utf-8",
  );
}
