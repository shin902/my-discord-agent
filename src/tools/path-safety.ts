/**
 * 正規化済みの相対パスが `..` でワークスペース外に出ようとしていないか検証する。
 * `fs.ts`（sanitizePath）と `git.ts`（resolveCloneDir）で同じ判定条件が
 * 重複実装されていたため、判定ロジックのみをここに共通化している。
 *
 * 絶対パスの扱い（許可するか拒否するか）は呼び出し側の仕様が異なるため、
 * このヘルパーには含めない。呼び出し側で個別に処理すること。
 *
 * @param normalized `normalize()` 済みの相対パス文字列
 * @param raw エラーメッセージに使う元の生入力文字列
 * @param baseMessage `..` 検出時に投げるエラーメッセージ（`(${raw})` が末尾に付与される）
 */
export function assertNoParentTraversal(
  normalized: string,
  raw: string,
  baseMessage: string,
): void {
  if (normalized.startsWith("..")) {
    throw new Error(`${baseMessage} (${raw})`);
  }
}
