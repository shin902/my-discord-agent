# cron 設計メモ

## 概要

定期実行ジョブの基盤。1分ごとに有効なジョブをチェックし、条件を満たせばエージェントへ投げる。

---

## ファイル構成

```
config/cron.json           # ジョブ定義（省略可。トップレベルは配列）
src/cron/
  runner.ts                # 1分ごとのスケジューラ（薄い実行基盤）
  jobs/
    mail.ts                # メール固有ジョブ（TSバインド方式）
    *.ts                   # 将来追加するジョブ
data/cron/
  state.json               # 各ジョブの lastRun を記録（重複実行防止）
```

---

## ジョブ定義（config/cron.json）

### 通常ジョブ（JSONだけで完結）

```json
[
  {
    "id": "daily-report",
    "schedule": "0 9 * * *",
    "groupName": "my-group",
    "prompt": "昨日のログを分析して日次レポートを作成してください",
    "channelId": "12345",
    "deliveryMode": "new-thread",
    "sessionMode": "destination"
  }
]
```

### カスタムジョブ（TSファイルをバインド）

```json
[
  {
    "id": "mail-check",
    "schedule": "*/30 * * * *",
    "groupName": "email",
    "channelId": "12345",
    "deliveryMode": "item-thread",
    "sessionMode": "destination",
    "handler": "jobs/mail.ts"
  }
]
```

`handler` があるジョブは `prompt`・`channelId`・`deliveryMode`・`sessionMode` を省略可能。省略しない場合は `CronContext` 経由でハンドラーに渡される。

---

## フィールド定義

| フィールド | 必須 | 型 | 説明 |
|-----------|------|-----|------|
| `id` | ✓ | string | ジョブID（一意） |
| `schedule` | ✓ | string | cron式 `"0 9 * * *"` or インターバル `"30m"` `"1h"` |
| `groupName` | handler なし時必須 / handler あり時オプション | string | エージェントグループ名。handler ありジョブでも記載すれば `CronContext.groupName` 経由で参照できる |
| `prompt` | handler なし時必須 | string | エージェントへのプロンプト |
| `channelId` | handler なし時必須 | string | 送信先 Discord チャンネル ID |
| `deliveryMode` | handler なし時必須 | `"direct"` \| `"new-thread"` \| `"item-thread"` | Discordへの投稿方法（後述） |
| `sessionMode` | handler なし時必須 | `"per-run"` \| `"destination"` | セッションIDの決定方法（後述） |
| `mode` | オプション | `"to-channel"` \| `"to-thread"` | 旧設定との後方互換用。新規設定では使用しない |
| `handler` | オプション | string | カスタムロジックの TS ファイルパス（`src/cron/` からの相対パス。`../` などパストラバーサルは正規表現で弾く） |
| `settings` | オプション | unknown | ハンドラー固有の設定値置き場。中身は検証せずそのまま `CronContext.settings` 経由でハンドラーに渡す。ハンドラー側で必要な型にキャスト、または自前で Zod パースして使う |

handlerが設定されてる場合、JSONの全フィールドは `CronContext` に詰めてハンドラーに渡す。"handler なし時必須" フィールドはhandlerありの場合オプション扱いになるが、記載すればハンドラーから参照できる。

### settings の例

```json
{
  "id": "some-job",
  "schedule": "*/30 * * * *",
  "handler": "jobs/some-job.ts",
  "settings": { "maxResults": 10, "labelFilter": "INBOX" }
}
```

### deliveryMode / sessionMode

投稿方法とセッションID戦略は独立して指定する。すべての組み合わせで `appendInbox()` 経由の非同期処理となり、cron tick はキューへの追加後に返る。

| フィールド | 値 | 動作 |
|---|---|---|
| `deliveryMode` | `direct` | `channelId` が指すチャンネルまたは既存スレッドへ直接投稿する |
| `deliveryMode` | `new-thread` | `channelId` を親チャンネルとして毎回新規スレッドを作成し、そこへ投稿する |
| `deliveryMode` | `item-thread` | 処理前に仮メッセージと1項目用スレッドを確保し、仮メッセージを回答先頭で編集する。handlerなしジョブではpollerがAI前に確保する |
| `sessionMode` | `per-run` | 実行ごとに一意なセッションIDを生成する |
| `sessionMode` | `destination` | 実際の投稿先チャンネルまたはスレッドIDをセッションIDとして使う |

代表的な組み合わせ:

| 設定 | 用途 |
|---|---|
| `direct` + `per-run` | 同じチャンネルまたは既存スレッドへ投稿するが、実行ごとの履歴は分離する |
| `direct` + `destination` | 投稿先単位で履歴を継続する |
| `new-thread` + `destination` | 毎回新規スレッドを作り、その後のユーザー返信でも履歴を継続する |
| `new-thread` + `per-run` | 毎回新規スレッドを作るが、cron実行の履歴はユーザー返信へ引き継がない |
| `item-thread` + `destination` | 1項目ごとに仮メッセージと独立スレッドを先に確保し、そのスレッドをAI・ユーザー返信のセッションにする。`item-thread` は `destination` 必須 |

旧 `mode` は後方互換のため受理する。`to-channel` は `direct` + `per-run`、`to-thread` は `new-thread` + `destination` に変換する。旧 `mode` と新しい2フィールドは同時指定できない。item-threadを使うhandler付きジョブは `CronContext.deliveryMode` に `item-thread` を指定する。mail.ts は `deliveryMode` 省略時もitem-threadとして扱う既存設定互換を維持し、明示的に別モードを指定した場合は設定エラーにする。

---

## TSバインドジョブのインターフェース

```typescript
// src/cron/jobs/mail.ts
export default async function handler(ctx: CronContext): Promise<void> {
  // ctx に client, appendInbox などが入る
}
```

`CronContext` に含めるもの:
- Discord `client`
- `appendInbox`
- ジョブ定義の全フィールド（`id`, `schedule`, `groupName?`, `prompt?`, `channelId?`, `deliveryMode?`, `sessionMode?`, `mode?`, `handler?`, `settings?`）を展開して渡す

複数項目を扱うhandlerは、各項目を `enqueueCronItemThread(ctx, content, { idempotencyKey, sourceType, sourceId, threadName })` で登録・provisioningする。handlerから呼ぶ場合、`idempotencyKey` は外部項目に対応する安定した値として必須であり、helperが自動生成することはない。宣言的な `item-thread` ジョブは通常の `enqueueCronInbox()` から登録され、handlerなしの実行に限って内部用のper-run keyを生成してpollerがAI実行前にprovisioningする。source固有の発見処理と完了ACKはhandler側に残す。

---

## スケジュール形式

- **cron式**: `"0 9 * * *"` — 分・時・日・月・曜日。標準的な cron 記法
- **インターバル**: `"30m"` `"1h"` `"2h"` — 起動からの経過時間ベース

**重複実行防止**: `data/cron/state.json` に各ジョブの `lastRun` を記録。

- **cron式**: チェック条件は `前回実行時刻 < 今回の予定実行時刻 ≤ 現在時刻`。これにより `0 9 * * *` が 9:00〜9:59 の間に何度もマッチする問題を防ぐ。
- **インターバル**: チェック条件は `lastRun + interval ≤ 現在時刻`。

`state.json` の構造例:

```json
{
  "daily-report": { "lastRun": "2025-01-01T09:00:00.000Z" },
  "mail-check": { "lastRun": "2025-01-01T09:30:00.000Z" }
}
```

---

## メール処理（`jobs/mail.ts`）

メールハンドラーはメールの発見とDiscord作業場所の確保だけを担当し、AIを直接呼び出さない。各メールは `mail:{messageId}` という安定した冪等キーで予約するため、次回のcron実行で同じメールを二重にAI処理しない。

1. 未読メールを取得し、既存の予約がなければ本文を取得してinboxへ登録する。
2. 処理中の仮メッセージを親チャンネルへ投稿し、そのメッセージからスレッドを作成する。作成済みの仮メッセージとスレッドは保存したIDから再利用する。
3. 仮メッセージIDとスレッドIDを永続化してから、pollerがAI処理をclaimする。作成途中のジョブは次回のmail cronで再試行する。
4. AI実行は通常のpollerを通り、providerのconcurrency設定、同一セッション内の順序保証、既存のセッション履歴をそのまま利用する。別スレッドは並列化でき、同じスレッド内の処理は直列になる。
5. 成功した回答の先頭chunkで仮メッセージを編集し、残りのchunkは同じスレッドへ順番に投稿する。AIまたはDiscord deliveryが最終的に失敗した場合は、可能なら仮メッセージを `⚠️ 処理に失敗しました` へ編集する。
6. 全てのDiscord deliveryが `sent` になった後、次回のmail cronでメールを既読化する。AI失敗、delivery失敗、既読化失敗のいずれでもメールは未読のまま残る。

一時的なAIエラーは通常のキュー再試行機構に任せる。Discordのdeliveryエラーはdelivery workerが再試行する。placeholderの最終回答編集は冪等な操作として、Discordのエラー内容にかかわらず最大3回（初回を含む）試行する。3回失敗したdeliveryは終端化し、次回のcron reconciliationで失敗表示を1回だけ試みる。新しいメッセージ送信やスレッド作成など、送信結果が不明な外部変異は `ambiguous` として自動再送しない。

同じメールアカウント・同じメールソースを対象にする `mail.ts` のcronエントリやハンドラーを複数設定してはいけない。冪等キーはcronの次回実行時の重複を防ぐためのもので、複数producerや複数ホストによるprovisioningの協調を保証するものではない。

## 運用メモ

### config/cron.json の変更を反映するには再起動が必要

起動時に `loadAndValidateCron()` がジョブ定義を一度だけ読み込み、結果を `runner.ts` のモジュールレベル変数 `_jobs` にセットする。`tick()` は毎分このメモリ上の `_jobs` を参照するだけでファイルの再読み込みは行わないため、`config/cron.json` を編集してもプロセスを再起動するまで変更は反映されない。これは `group-config.ts` と同じキャッシュ戦略。

`config/cron.json` は省略可能なため、ファイル自体が存在しない場合は `loadAndValidateCron()` がエラーにせず空配列を返し、cron が空扱いで起動する。この場合も後からファイルを配置しても再起動するまで cron は動き始めない（次の tick で自動回復する仕組みは存在しない）。

---

## スコープ外（別途検討）

- **一般deliveryのリトライ上限**: placeholderの最終回答編集は3回の固定上限を持つ。その他のdeliveryの再試行上限は未定義で、連続失敗時に `state.json` の `retryCount` で追跡してリトライを打ち切る設計（issue #74）。

- **`allowedTools` / `allowedSkills`**: ジョブごとにグループ設定のツール・スキルをオーバーライドする機能（issue #73）。`InboxMessage` と `sendMessage` 両方への対応が必要なため別途実装。

- **Discord カスタムスラッシュコマンド**: cron のトグル、ローカル LLM の Heartbeat 制御など（issue #70）。

## 没・保留

- **`session: "fixed"`**: 実行間で会話履歴を持ち越す固定セッション方式。channelId を永続化するだけでは複数ジョブがセッションを共有してしまう問題があり、エージェントの最終的なレスポンスのみを共有するか、具体的なユースケースも固まらなかったため削除。

- **サーバーが落ちてた間のジョブ再実行**: 停止中に実行予定だったジョブを再起動時に自動実行する機能。`state.json` の `lastRun` に加えて「次の予定実行時刻」も記録する必要があり実装が複雑になるため保留。

- **Heartbeat**: 一定間隔でエージェントに話しかけ続けるユースケース。実行のたびにセッションが積み上がりコンテキストが肥大化するため cron 基盤では対応しない。必要であればカスタムジョブとしてエージェントに作成依頼することを推奨。
