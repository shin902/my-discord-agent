import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NonRetryableError } from "../../utils/error.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../");

export function resolveFinanceDbPath(groupName: string): string {
  // ..セグメントによるディレクトリトラバーサルを防止（runner.ts の handler ガードと同様）
  if (/\.\.([/\\]|$)/.test(groupName)) {
    throw new NonRetryableError(`不正な groupName です: ${groupName}`);
  }
  const dbPath = path.join(ROOT, "groups", groupName, "finance.db");
  if (!existsSync(dbPath)) {
    throw new NonRetryableError(
      `finance.db が見つかりません。finance-setup スキルを先に実行してください: ${dbPath}`,
    );
  }
  return dbPath;
}
