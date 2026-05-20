import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), "data", "sessions");

function validateName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`不正な${label}: ${name}`);
  }
}

async function ensureDir(groupName: string): Promise<void> {
  const dir = path.join(SESSIONS_DIR, groupName);
  await mkdir(dir, { recursive: true, mode: 0o777 });
  // VirtioFS では mkdir の mode は既存ディレクトリに適用されないため明示的に設定
  await chmod(dir, 0o777);
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
    .map((line) => {
      // 後方互換: appendMessage 以前に保存された旧 JSONL に reasoning/thinking が
      // 残っている可能性があるため、ロード時も除去する。
      const msg = JSON.parse(line) as Record<string, unknown>;
      delete msg.reasoning;
      if (Array.isArray(msg.content)) {
        msg.content = (msg.content as Array<{ type: string }>).filter(
          (block) => block.type !== "thinking",
        );
      }
      return msg as unknown as AgentMessage;
    });
}

export async function appendMessage(
  groupName: string,
  sessionId: string,
  message: AgentMessage,
): Promise<void> {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");

  await ensureDir(groupName);

  // reasoning/thinkingをセーブ時に除去してJSONLをクリーンに保つ。
  // AgentMessageの型には含まれないが、推論モデルが実行時に付与することがある。
  const { reasoning: _r, ...rest } = message as AgentMessage & {
    reasoning?: unknown;
    reasoning_content?: string;
  };
  const sanitized: Record<string, unknown> = {
    ...rest,
    content: Array.isArray(rest.content)
      ? rest.content.filter(
          (b): b is typeof b => (b as { type?: string }).type !== "thinking",
        )
      : rest.content,
  };

  // Kimi K2.6 / DeepSeek V4 の thinking mode では、ツールコールを含む
  // assistant メッセージに reasoning_content が必須。欠けていると次ターンで HTTP 400。
  // refs: Hermes Agent v0.12.0 #15762, NousResearch/hermes-agent#16844
  if (
    rest.role === "assistant" &&
    Array.isArray(sanitized.content) &&
    (sanitized.content as Array<{ type?: string }>).some(
      (b) => b.type === "tool_use",
    ) &&
    sanitized.reasoning_content === undefined
  ) {
    sanitized.reasoning_content = " ";
  }

  const filePath = sessionPath(groupName, sessionId);
  // VirtioFS UID ミスマッチ対策: 既存ファイルが他UID所有の場合に備えて事前に chmod
  await chmod(filePath, 0o666).catch(() => {});
  await appendFile(filePath, `${JSON.stringify(sanitized)}\n`, {
    encoding: "utf-8",
    mode: 0o666,
  });
}
