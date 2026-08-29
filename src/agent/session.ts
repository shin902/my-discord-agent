import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  link,
  mkdir,
  readFile,
  rename,
  unlink,
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

const TIME_ANCHOR_PATTERN = /^[1-9]\d{12}$/;
const TIME_ANCHOR_REPAIR_WAIT_MS = 10;
const TIME_ANCHOR_REPAIR_TIMEOUT_MS = 1000;

function isValidTimeAnchor(timestamp: number): boolean {
  return (
    Number.isSafeInteger(timestamp) &&
    TIME_ANCHOR_PATTERN.test(String(timestamp))
  );
}

function parseTimeAnchor(value: string): number | undefined {
  const serialized = value.trim();
  // Date.now() produces a 13-digit epoch-millisecond timestamp. Requiring the
  // complete shape prevents a numeric prefix from being accepted as 1970 time.
  if (!TIME_ANCHOR_PATTERN.test(serialized)) return undefined;

  const timestamp = Number(serialized);
  return isValidTimeAnchor(timestamp) ? timestamp : undefined;
}

type TimeAnchorState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; timestamp: number };

async function readTimeAnchorState(file: string): Promise<TimeAnchorState> {
  try {
    const timestamp = parseTimeAnchor(await readFile(file, "utf-8"));
    return timestamp === undefined
      ? { kind: "invalid" }
      : { kind: "valid", timestamp };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    throw err;
  }
}

async function repairTimeAnchor(
  file: string,
  temporaryFile: string,
): Promise<number> {
  // The fixed claim is a hard link to a complete candidate. Every publisher
  // uses that inode, so concurrent and recovered publishers cannot introduce a
  // different value for this session.
  const claimPath = `${file}.repair`;
  let ownsClaim = false;
  try {
    try {
      await link(temporaryFile, claimPath);
      ownsClaim = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const deadline = Date.now() + TIME_ANCHOR_REPAIR_TIMEOUT_MS;
    while (true) {
      const current = await readTimeAnchorState(file);
      if (current.kind === "valid") return current.timestamp;

      const candidate = await readTimeAnchorState(claimPath);
      if (candidate.kind === "valid") {
        // Never rename the reusable claim path itself. A unique hard-link
        // snapshot pins this exact inode while the atomic publication occurs;
        // an abandoned claim remains available for later crash recovery.
        const snapshotPath = `${claimPath}.${process.pid}.${randomUUID()}.snapshot`;
        try {
          await link(claimPath, snapshotPath);
          const beforePublish = await readTimeAnchorState(file);
          if (beforePublish.kind === "valid") return beforePublish.timestamp;

          await rename(snapshotPath, file);
          const winner = await readTimeAnchorState(file);
          if (winner.kind === "valid") return winner.timestamp;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "EEXIST") throw err;
        } finally {
          await unlink(snapshotPath).catch(() => {});
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`時刻sidecarの修復がタイムアウトしました: ${file}`);
      }
      await new Promise((resolve) =>
        setTimeout(resolve, TIME_ANCHOR_REPAIR_WAIT_MS),
      );
    }
  } finally {
    if (ownsClaim) await unlink(claimPath).catch(() => {});
  }
}

/**
 * セッション開始時刻を会話JSONLとは別のsidecarへ一度だけ固定する。
 * 既存セッション移行時は caller が履歴の最古timestampを fallback として渡せる。
 * sidecar は完成済みtmpから原子的に公開し、旧実装由来の壊れたsidecarは自己修復する。
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
  const initialState = await readTimeAnchorState(file);
  if (initialState.kind === "valid") return initialState.timestamp;

  const timestamp = isValidTimeAnchor(fallbackTimestamp)
    ? fallbackTimestamp
    : Date.now();
  const temporaryFile = `${file}.${process.pid}.${randomUUID()}.tmp`;

  await writeFile(temporaryFile, `${timestamp}\n`, {
    encoding: "utf-8",
    mode: 0o666,
    flag: "wx",
  });

  try {
    // Missing entries, concurrent initialization, and rolling-upgrade partial
    // entries all use the same claim protocol, so no caller can publish a
    // different candidate while a repair is in progress.
    return await repairTimeAnchor(file, temporaryFile);
  } finally {
    // rename済みならENOENT、link済みならtmp名だけを削除する。cleanup失敗でsessionを壊さない。
    await unlink(temporaryFile).catch(() => {});
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
