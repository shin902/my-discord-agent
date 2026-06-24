/**
 * inbox キュー — Discord から受け取ったメッセージを処理前に一時保存する。
 *
 * フロー: Discord受信 → appendInbox() → poller が peekAllUnclaimedInbox() で取り出して処理
 *  → 処理完了後に removeInboxById()、リトライ時は updateInboxById() で更新
 *
 * ファイル形式は JSONL（1行1メッセージ）。例：
 *   {"id":"msg-1234-abc","channelId":"9876","content":"こんにちは","timestamp":"2026-05-06T10:00:00.000Z","retries":0}
 *   {"id":"msg-1235-def","channelId":"9876","content":"返事して","timestamp":"2026-05-06T10:00:01.000Z","retries":0}
 *
 * peekAllUnclaimedInbox() は処理中（in-flight）のメッセージをファイルから削除しない。
 * これにより、再起動時にも未完了のメッセージがキューに残り続ける（#69）。
 * JSONL はインプレース更新ができないため、remove/update 系はファイル全体を書き直す。
 * readFile と writeFile の間に appendInbox が割り込むとメッセージが消えるため、
 * Promise チェーンで全ファイル操作を直列化している。
 */

import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFileLock } from "../utils/lock.js";
import { appendCorruptedDeadLetter } from "./dead-letter.js";

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

// ファイルが存在しなければ空配列を返す。各行は JSON.parse 済みの InboxMessage。
// クラッシュ時の書き込み途中切断などで不正なJSON行が混入していた場合、
// その行は dead-letter.jsonl に退避し、inbox.jsonl からは除去する。
async function readMessages(): Promise<InboxMessage[]> {
  if (!existsSync(INBOX_PATH)) return [];
  const text = await readFile(INBOX_PATH, "utf-8");
  const valid: InboxMessage[] = [];
  let hasCorrupted = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      valid.push(JSON.parse(line) as InboxMessage);
    } catch (err) {
      hasCorrupted = true;
      console.error(
        "[inbox] 不正なJSON行を検出。dead-letterへ退避:",
        line,
        err,
      );
      await appendCorruptedDeadLetter(line);
    }
  }
  if (hasCorrupted) {
    await writeMessages(valid);
  }
  return valid;
}

async function writeMessages(messages: InboxMessage[]): Promise<void> {
  const body = messages.map((msg) => JSON.stringify(msg)).join("\n");
  await writeFile(INBOX_PATH, body ? `${body}\n` : "", "utf-8");
}

// ファイル操作を直列化するミューテックス。
// Node.js は await をまたいでイベントループが切り替わるため、
// readFile→writeFile の間に appendInbox が割り込む可能性がある。
const withFileLock = createFileLock();

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
 * excludeIds に含まれない全件を、ファイル順を保ったまま取り出す。ファイルからは削除しない。
 *
 * poller はこの呼び出しで claim したメッセージを処理が完全に終わるまで
 * excludeIds（in-flight セット）に入れておくことで、同じメッセージを
 * 取り出し直してしまうのを防ぐ。実際の削除は removeInboxById() で行う。
 *
 * in-flight のメッセージはファイルから消えずに残るため、1件ずつ peek すると
 * 呼び出すたびにファイル全体を読み直し、残っている in-flight 分を毎回スキップする
 * コストがかかる（in-flight 数 × 呼び出し回数）。1回の読み込みで未claim分を
 * まとめて返すことで、ポーラーの1ループ（tick）あたりの読み込み回数を1回に抑える。
 */
export async function peekAllUnclaimedInbox(
  excludeIds: ReadonlySet<string>,
): Promise<InboxMessage[]> {
  return withFileLock(async () => {
    const messages = await readMessages();
    return messages.filter((msg) => !excludeIds.has(msg.id));
  });
}

/** 処理が完全に終わった（成功 / dead-letter）メッセージをファイルから削除する。 */
export async function removeInboxById(id: string): Promise<void> {
  return withFileLock(async () => {
    if (!existsSync(INBOX_PATH)) return;
    const messages = await readMessages();
    await writeMessages(messages.filter((msg) => msg.id !== id));
  });
}

/** リトライ時に該当メッセージのフィールドを位置を保ったまま更新する。 */
export async function updateInboxById(
  id: string,
  patch: Partial<InboxMessage>,
): Promise<void> {
  return withFileLock(async () => {
    if (!existsSync(INBOX_PATH)) return;
    const messages = await readMessages();
    await writeMessages(
      messages.map((msg) => (msg.id === id ? { ...msg, ...patch } : msg)),
    );
  });
}
