# poller ディスパッチモード設計メモ

## 解決する問題

現行の poller はチャンネル単位でメッセージを直列化している。この粒度では以下の問題がある。

- ローカルLLM など同時処理数=1 の環境では、異なるチャンネルのメッセージが並列で sendMessage に到達し、後発のジョブがサンドボックスのタイムアウトに引っかかりうる
- 逆に複数LLM・APIキーを使う環境では、チャンネル単位ロックは粗すぎて並列化の恩恵を受けにくい

---

## 採用方針

ロック粒度を設定で切り替えられるようにする。

| モード | ロック単位 | 適した環境 |
|---|---|---|
| `serial` | グローバル単一キュー（全メッセージを直列） | ローカルLLM など同時処理数=1 |
| `parallel-session` | セッションID ごと（同一セッションは直列、別セッションは並列） | 複数LLM・APIキーで並列処理できる環境 |

デフォルトは `serial`。設定ファイル（`config/poller.json`）または環境変数 `POLLER_DISPATCH_MODE` で切り替える。

現行の「チャンネル単位」ロックは廃止し、どちらかを選ぶ。

### parallel-session モードでのセッションID の意味

| メッセージ種別 | セッションID の値 | ロックの効果 |
|---|---|---|
| shared モード | チャンネルID | 同一チャンネルは直列（現行と同等） |
| thread / auto-thread モード | スレッドID | 同一スレッドは直列、別スレッドは並列 |
| cron-thread | `cron-{ジョブID}`（placeholder） | 同一ジョブの重複起動を直列化 |

---

## 実装（`queue/poller.ts`）

### ディスパッチ関数

```typescript
type DispatchMode = "serial" | "parallel-session";

// serial: グローバル直列キュー
let globalChain = Promise.resolve();

// parallel-session: セッション単位キュー
const sessionChain = new Map<string, Promise<void>>();

function dispatch(
  sessionId: string,
  fn: () => Promise<void>,
  mode: DispatchMode,
): void {
  const onError = (err: unknown) => {
    console.error("[poller] 予期せぬエラー:", err);
  };
  if (mode === "serial") {
    globalChain = globalChain.then(fn).catch(onError);
  } else {
    const prev = sessionChain.get(sessionId) ?? Promise.resolve();
    const next = prev.then(fn).catch(onError);
    sessionChain.set(sessionId, next);
    // 完了後にエントリを削除してメモリリークを防ぐ
    next.finally(() => {
      if (sessionChain.get(sessionId) === next) sessionChain.delete(sessionId);
    });
  }
}
```

**エラー時の挙動**: あるタスクが失敗しても `onError` でエラーを飲み込んで resolved に戻すため、後続タスクは通常通り実行される。

**メモリ管理**: `parallel-session` モードでは処理完了後に `.finally()` でエントリを削除する。削除しないとセッションIDが増えるたびに Map が肥大化する。

### poll ループの変更

```typescript
// 変更前: チャンネル単位ロック
dispatchWithChannelLock(msg.channelId, () => processMessage(msg));

// 変更後: セッション単位（またはグローバル）ロック
dispatch(msg.sessionId, () => processMessage(msg), mode);
```

---

## 変更ファイルまとめ

| ファイル | 変更内容 |
|---|---|
| `queue/poller.ts` | `dispatchWithChannelLock` を廃止し `dispatch(sessionId, fn, mode)` に一本化、`sessionChain` の `.finally()` クリーンアップ追加 |
| `config/poller.json`（新規・任意） | `{ "dispatchMode": "serial" }` 形式。未設定時は `serial` |
