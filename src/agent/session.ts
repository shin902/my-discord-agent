import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
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
  await chmod(dir, 0o777).catch(() => {});
}

function sessionPath(groupName: string, sessionId: string): string {
  return path.join(SESSIONS_DIR, groupName, `${sessionId}.jsonl`);
}

function sessionTimeAnchorPath(groupName: string, sessionId: string): string {
  return path.join(SESSIONS_DIR, groupName, `${sessionId}.time-anchor`);
}

function hasArrayContent(
  msg: object,
): msg is { content: Array<{ type?: string }> } {
  return (
    "content" in msg && Array.isArray((msg as { content: unknown }).content)
  );
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
      // 後方互換: 旧バージョンが保存した不要フィールドをロード時に除去する。
      // - reasoning: pi-ai が旧来付与していたフィールド
      // - reasoning_content: 廃止された appendMessage のパッド補完が書き込んだフィールド
      const msg = JSON.parse(line) as Record<string, unknown>;
      delete msg.reasoning;
      delete msg.reasoning_content;
      if (Array.isArray(msg.content)) {
        msg.content = (msg.content as Array<{ type: string }>).filter(
          (block) => block.type !== "thinking",
        );
      }
      return msg as unknown as AgentMessage;
    });
}

function parseTimeAnchor(value: string): number | undefined {
  const timestamp = Number(value.trim());
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

/**
 * セッション開始時刻を会話JSONLとは別のsidecarへ一度だけ固定する。
 * 既存セッション移行時は caller が履歴の最古timestampを fallback として渡せる。
 */
export async function loadOrCreateSessionTimeAnchor(
  groupName: string,
  sessionId: string,
  fallbackTimestamp = Date.now(),
): Promise<number> {
  validateName(groupName, "グループ名");
  validateName(sessionId, "セッションID");
  await ensureDir(groupName);

  const file = sessionTimeAnchorPath(groupName, sessionId);
  try {
    const existing = parseTimeAnchor(await readFile(file, "utf-8"));
    if (existing !== undefined) return existing;
    throw new Error(`不正なセッション時刻アンカー: ${file}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const timestamp =
    Number.isFinite(fallbackTimestamp) && fallbackTimestamp > 0
      ? fallbackTimestamp
      : Date.now();
  try {
    await writeFile(file, `${timestamp}\n`, {
      encoding: "utf-8",
      mode: 0o666,
      flag: "wx",
    });
    return timestamp;
  } catch (err) {
    // 同一セッションの初期化が競合した場合は、先に作られた値を正本にする。
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const existing = parseTimeAnchor(await readFile(file, "utf-8"));
    if (existing === undefined) {
      throw new Error(`不正なセッション時刻アンカー: ${file}`);
    }
    return existing;
  }
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
  };
  const sanitized: Record<string, unknown> = { ...rest };
  if (hasArrayContent(rest)) {
    sanitized.content = rest.content.filter((b) => b.type !== "thinking");
  }

  const filePath = sessionPath(groupName, sessionId);
  // VirtioFS UID ミスマッチ対策: 既存ファイルが他UID所有の場合に備えて事前に chmod
  await chmod(filePath, 0o666).catch(() => {});
  await appendFile(filePath, `${JSON.stringify(sanitized)}\n`, {
    encoding: "utf-8",
    mode: 0o666,
  });
}
