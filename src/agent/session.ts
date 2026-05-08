import { readFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

const SESSIONS_DIR = path.join(process.cwd(), 'data', 'sessions');

async function ensureDir(groupName: string): Promise<void> {
  await mkdir(path.join(SESSIONS_DIR, groupName), { recursive: true });
}

function sessionPath(groupName: string, sessionId: string): string {
  return path.join(SESSIONS_DIR, groupName, `${sessionId}.jsonl`);
}

export async function loadMessages(groupName: string, sessionId: string): Promise<AgentMessage[]> {
  const file = sessionPath(groupName, sessionId);
  if (!existsSync(file)) return [];

  const text = await readFile(file, 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AgentMessage);
}

export async function appendMessage(groupName: string, sessionId: string, message: AgentMessage): Promise<void> {
  await ensureDir(groupName);
  await appendFile(sessionPath(groupName, sessionId), JSON.stringify(message) + '\n', 'utf-8');
}
