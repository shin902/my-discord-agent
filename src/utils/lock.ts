/**
 * 同一プロセス内のファイル操作をPromiseチェーンで直列化するミューテックスを生成する。
 * Node.js は await をまたいでイベントループが切り替わるため、read→write の間に
 * 別の呼び出しが割り込むとデータが消えることがある（inbox.ts / issue-triage.ts で使用）。
 */
export function createFileLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let pending: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = pending.then(fn);
    pending = result.then(
      () => {},
      () => {},
    );
    return result;
  };
}
