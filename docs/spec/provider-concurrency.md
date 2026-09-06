# プロバイダー同時実行設計（歴史的資料）

この文書は設計時点の記録であり、現行仕様ではありません。以下の `sessionChain` は廃止されており、記載したファイルパスも当時のものです。現行のprovider設定は [設定リファレンス](../config.md#configprovidersjson)、SQLiteによるsession順序制御は [永続キューとDiscord配送](../inbox-queue.md#状態と順序) を参照してください。

## 解決する問題

同時実行数が1に制限されるローカル LLM やクラウドプロバイダーと、複数実行できる Codex 等を同じ bot で使う。全モデルを1本のグローバルキューに入れると並列実行できるプロバイダーまで待たされ、ロックをなくすと同時実行数1のプロバイダーで競合する。

必要な挙動は次のとおり。

- 同じセッションのメッセージは受信順に処理する
- `serial` provider は同じ provider 内だけ1件ずつ処理する
- 異なる `serial` provider 同士は並列実行できる
- `parallel` provider は他の provider と独立して並列実行できる

## 二段階の直列化

### セッションチェーン

`queue/poller.ts` の `sessionChain` は同じ `sessionId` のメッセージを常に直列化する。異なるセッションは provider ロックの取得まで並列に進む。

### provider ミューテックス

`config/providers.json` に AI provider ごとの `concurrency` を指定する。

```json
[
  { "provider": "local-a", "concurrency": "serial" },
  { "provider": "local-b", "concurrency": "serial" },
  { "provider": "codex-oauth", "concurrency": "parallel" }
]
```

| `concurrency` | LLM ロック |
|---|---|
| `serial` | provider 名をキーにした FIFO ミューテックス |
| `parallel` | なし |
| provider の設定なし | 安全側の `serial` |

`serial` の `local-a` が実行中でも `local-b` と `codex-oauth` は開始できる。一方、別セッションから来た2件の `local-a` 実行は先行処理の完了まで待つ。

旧 `poller.dispatchMode` と `POLLER_DISPATCH_MODE` は廃止する。グローバルロックは持たず、直列化の範囲は常に provider 単位とする。

## 設定解決

通常の Discord メッセージはAgentConfigを `group → channel` の順に、cronは配送先channelの設定を継承せず `group → cron job` の順に解決する。その後の `model` を使い、最後に `defaultModel` で補完する。解決した `provider` と同名の `providers.json` エントリから `concurrency` を取得して LLM ロックを取る。

## 変更ファイル

| ファイル | 内容 |
|---|---|
| `config/providers.ts` | provider ポリシーのスキーマ、ロード、`serial` デフォルト |
| `queue/poller.ts` | 実行対象 provider と concurrency の解決 |
| `queue/llm-mutex.ts` | provider 単位の FIFO ミューテックス |
