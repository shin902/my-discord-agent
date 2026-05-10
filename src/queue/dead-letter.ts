import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InboxMessage } from "./inbox.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = path.join(__dirname, "../../data/queue");
const DEAD_LETTER_PATH = path.join(QUEUE_DIR, "dead-letter.jsonl");

let pendingOp = Promise.resolve<void>(undefined);
function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = pendingOp.then(fn);
  pendingOp = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** MAX_RETRIES を超えたメッセージを dead-letter.jsonl に移す。調査用。 */
export async function appendDeadLetter(msg: InboxMessage): Promise<void> {
  return withFileLock(async () => {
    await mkdir(QUEUE_DIR, { recursive: true });
    await appendFile(DEAD_LETTER_PATH, `${JSON.stringify(msg)}\n`, "utf-8");
  });
}
