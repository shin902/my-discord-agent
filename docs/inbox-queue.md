# インボックスキューのファイルミューテックス

`src/queue/inbox.ts` の設計メモ。

## 問題

JSONL はインプレース更新ができないため、`removeInboxById` / `updateInboxById` はファイル全体を書き直す。
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

`pendingOp` はモジュールスコープの変数なので、`appendInbox` / `peekAllUnclaimedInbox` / `removeInboxById` / `updateInboxById` の4関数が同じキューを共有する。

## API

| 関数 | 用途 |
|---|---|
| `appendInbox(msg)` | Discord 受信時にキュー末尾へ追記。`id`・`retries` は自動付与 |
| `peekAllUnclaimedInbox(excludeIds)` | `excludeIds`（in-flight 集合）に含まれない全件をファイル順のまま取得。**削除はしない** |
| `removeInboxById(id)` | 処理が完全に終わった（成功 / dead-letter）メッセージを該当id行のみ削除 |
| `updateInboxById(id, patch)` | リトライ時に該当id行を**位置を保ったまま**部分更新（`retries` 等） |

`peekAllUnclaimedInbox` は処理中（in-flight）のメッセージをファイルから削除しない設計（#69）。これにより再起動時にも未完了のメッセージがキューに残り続け、再開できる。poller は claim したメッセージIDをメモリ上の `inFlightIds` で追跡し、処理完了時に `removeInboxById` / `updateInboxById` を呼んで初めてファイルが変化する。

旧 `prependInbox` はリトライメッセージをキュー先頭に戻して優先的に再処理していたが、`updateInboxById` は元の位置を保ったまま更新するため、リトライ中のメッセージは（先頭に戻らず）元の位置のままになる。

`InboxMessage` の主要フィールド: `id`, `channelId`, `groupName`, `sessionId`, `messageId`（オプション）, `content`, `timestamp`, `retries`
