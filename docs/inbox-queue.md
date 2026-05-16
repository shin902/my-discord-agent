# インボックスキューのファイルミューテックス

`src/queue/inbox.ts` の設計メモ。

## 問題

JSONL はインプレース更新ができないため、`shiftInbox` / `prependInbox` はファイル全体を書き直す。
`readFile → writeFile` の間に `appendInbox` が割り込むと、`writeFile` が `appendInbox` の書き込みを上書きしてメッセージが消える。

## 解決策：Promise チェーンによる直列化

```ts
let pendingOp = Promise.resolve<void>(undefined);

function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = pendingOp.then(fn);
  pendingOp = result.then(() => {}, () => {});
  return result;
}
```

`pendingOp` に「直前の操作が完了するまで待つ Promise」を常に持ち続けることで、全ファイル操作を自動的に直列化する。`result.then(() => {}, () => {})` は操作が失敗しても `pendingOp` が rejected のままにならないための処理（rejected のままだと後続の操作がすべてブロックされる）。

`pendingOp` はモジュールスコープの変数なので、`appendInbox` / `shiftInbox` / `prependInbox` の3関数が同じキューを共有する。

## API

| 関数 | 用途 |
|---|---|
| `appendInbox(msg)` | Discord 受信時にキュー末尾へ追記。`id`・`retries` は自動付与 |
| `shiftInbox()` | Poller が先頭1件を取り出して削除。空なら `null` |
| `prependInbox(msg)` | リトライ時にメッセージをキュー先頭に戻す |

`InboxMessage` の主要フィールド: `id`, `channelId`, `groupName`, `sessionId`, `messageId`（オプション）, `content`, `timestamp`, `retries`
