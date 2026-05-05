import { readFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import type { AgentMessage } from '@mariozechner/pi-agent-core';

/** セッションファイルの保存先ディレクトリ。
 * ./data/sessions/
 */
const SESSIONS_DIR = path.join(process.cwd(), 'data', 'sessions');

/** セッションディレクトリが存在しない場合に作成する */
async function ensureDir(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true });
}

/** sessionId に対応する JSONL ファイルのパスを返す
 * 保存先: ./data/sessions/{sessionId}.jsonl
*/
function sessionPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

/**
 * 指定セッションの会話履歴を JSONL から読み込んで返す。
 * ファイルが存在しない場合は空配列を返す。
 */
export async function loadMessages(sessionId: string): Promise<AgentMessage[]> {
  const file = sessionPath(sessionId);
  if (!existsSync(file)) return [];

  const text = await readFile(file, 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.trim())   // 行ごとにtrim()して、空行を除外。trim()はスペース・タブ・空行を削除してくれる
    .map((line) => JSON.parse(line) as AgentMessage);
}

/**
 * メッセージを JSONL に1行追記する。
 * 書き込みは append のみなので、既存の履歴を壊さない。
 */
export async function appendMessage(sessionId: string, message: AgentMessage): Promise<void> {
  await ensureDir();
  await appendFile(sessionPath(sessionId), JSON.stringify(message) + '\n', 'utf-8');
}
