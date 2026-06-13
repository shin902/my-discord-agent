/**
 * inbox キュー — Discord から受け取ったメッセージを処理前に一時保存する。
 *
 * フロー: Discord受信 → appendInbox() → poller が shiftInbox() で取り出して処理
 *
 * ファイル形式は JSONL（1行1メッセージ）。例：
 *   {"id":"msg-1234-abc","channelId":"9876","content":"こんにちは","timestamp":"2026-05-06T10:00:00.000Z","retries":0}
 *   {"id":"msg-1235-def","channelId":"9876","content":"返事して","timestamp":"2026-05-06T10:00:01.000Z","retries":0}
 *
 * JSONL はインプレース更新ができないため、shiftInbox / prependInbox はファイル全体を書き直す。
 * readFile と writeFile の間に appendInbox が割り込むとメッセージが消えるため、
 * Promise チェーンで全ファイル操作を直列化している。
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Discord メッセージに添付されたファイルの参照情報
export interface AttachmentRef {
  url: string;
  name: string;
  contentType: string | null;
  size: number;
}

// InboxMessage は JSONL の 1行 = 1レコードに対応する型
export interface InboxMessage {
  id: string;
  channelId: string;
  groupName: string;
  sessionId: string; // shared: channelId, thread/auto-thread: スレッドの channelId
  messageId?: string; // 返信引用に使う元メッセージの Discord ID。旧キュー互換のためオプショナル
  content: string;
  timestamp: string;
  retries: number; // 失敗してリトライした回数。初回は 0
  cronThread?: boolean; // cron thread モードのトリガー
  cronJobId?: string; // to-thread: スレッド名生成用（cron-${jobId}-${dateSuffix}）。to-channel: ツールコール通知抑制の判定用
  cronThreadId?: string; // スレッド作成後にセット。リトライ時の再作成を防ぐ
  attachments?: AttachmentRef[]; // Discord メッセージに添付されたファイル
}

// process.cwd() は起動ディレクトリに依存するため、ファイルの場所を基準にパスを解決する
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = path.join(__dirname, "../../data/queue");
const INBOX_PATH = path.join(QUEUE_DIR, "inbox.jsonl");

async function ensureDir(): Promise<void> {
  await mkdir(QUEUE_DIR, { recursive: true });
}

// ファイル操作を直列化するミューテックス。
// Node.js は await をまたいでイベントループが切り替わるため、
// readFile→writeFile の間に appendInbox が割り込む可能性がある。
let pendingOp = Promise.resolve<void>(undefined);
function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = pendingOp.then(fn);
  pendingOp = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** Discord のメッセージをキューの末尾に追記する。
 * id と retries は自動で付与される。Omitは除外の意味（関数内で生成するので、引数では明示しなくていい）
 */
export async function appendInbox(
  msg: Omit<InboxMessage, "id" | "retries">,
): Promise<void> {
  return withFileLock(async () => {
    await ensureDir();
    const record: InboxMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      retries: 0,
      ...msg,
    };
    await appendFile(INBOX_PATH, `${JSON.stringify(record)}\n`, "utf-8");
  });
}

/**
 * 先頭の1件を取り出してファイルから削除する。なければ null を返す。
 *
 * 取り出し後に失敗した場合は prependInbox() で先頭に戻す。
 */
export async function shiftInbox(): Promise<InboxMessage | null> {
  return withFileLock(async () => {
    if (!existsSync(INBOX_PATH)) return null;

    const text = await readFile(INBOX_PATH, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    const msg = JSON.parse(lines[0]) as InboxMessage;
    const remaining = lines.slice(1).join("\n");
    await writeFile(INBOX_PATH, remaining ? `${remaining}\n` : "", "utf-8");
    return msg;
  });
}

/** リトライ時にメッセージをキューの先頭に戻す。 */
export async function prependInbox(msg: InboxMessage): Promise<void> {
  return withFileLock(async () => {
    await ensureDir();
    const existing = existsSync(INBOX_PATH)
      ? await readFile(INBOX_PATH, "utf-8")
      : "";
    await writeFile(INBOX_PATH, `${JSON.stringify(msg)}\n${existing}`);
  });
}
