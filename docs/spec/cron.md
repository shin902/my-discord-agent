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
    "deliveryMode": "new-thread",
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
| `noReply` | オプション | boolean | `true`なら、このリクエストのsystem promptへ通知不要時に独立行 `<NO_REPLY>` を返す指示を追加。既定値は`false`。`item-thread`では利用不可 |
| `mode` | オプション | `"to-channel"` \| `"to-thread"` | 旧設定との後方互換用。新規設定では使用しない |
| `handler` | オプション | string | カスタムロジックの TS ファイルパス（`src/cron/` からの相対パス。`../` などパストラバーサルは正規表現で弾く） |
| `model` | オプション | object | AgentConfig。`provider` / `modelId` / `thinkingLevel`。group/channelのmodelオブジェクトを完全置換 |
| `tools` | オプション | string[] | AgentConfig。エージェントに渡すツール名。親の配列を完全置換 |
| `skills` | オプション | string[] / `"*"` | AgentConfig。親のスキル指定を完全置換 |
| `mounts` | オプション | object[] | AgentConfig。コンテナへの追加マウント。親のmounts配列を完全置換 |
| `settings` | オプション | unknown | ハンドラー固有の設定値置き場。中身は検証せずそのまま `CronContext.settings` 経由でハンドラーに渡す。ハンドラー側で必要な型にキャスト、または自前で Zod パースして使う |

handlerが設定されてる場合、JSONの全フィールドは `CronContext` に詰めてハンドラーに渡す。"handler なし時必須" フィールドはhandlerありの場合オプション扱いになるが、記載すればハンドラーから参照できる。

通常のDiscord会話におけるAgentConfigの解決順は `group → channel`、cron jobにおける解決順は `group → cron job` である。cronの `channelId` は配送先を指定するためだけに使われ、通常チャンネルIDでも既存スレッドIDでも配送先channelのAgentConfigは継承しない。未指定フィールドは親を継承し、指定フィールドはモデルオブジェクトや配列を含めて完全置換する。`allowMention` と `toolLogArgs` はgroup限定の配送・観測設定であり、channel/cronのAgentConfig override対象ではない。cronのAgentConfigは信頼済みの静的設定からのみ投入する。

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

応答中にtrim後が完全一致する独立行 `<NO_REPLY>` があれば、通常会話、および`direct`/`new-thread` cronは正常完了してDiscord deliveryを作らない。inlineの言及は通常どおり配送する。cronの`noReply: true`はこのプロトコルをsystem promptで案内するだけで、判定自体は常時有効である。ただし、事前にplaceholderとthreadを確保する`item-thread`では`noReply: true`を設定エラーとし、AGENTS.mdなどによってmarkerが出ても通常の応答テキストとして配送する。Mail/RSS sourceは無配信でも正常にACK/finalizeする。Mail ACK失敗時は未読のまま次回cronで再取得し、RSS settle失敗時はclaimを解放して次回cronで再取得する。`new-thread` + `destination` はthread IDをAIセッションに使うため実行前にスレッドを作成し、NO_REPLY時も投稿のないスレッドが残る。

旧 `mode` は後方互換のため受理する。`to-channel` は `direct` + `per-run`、`to-thread` は `new-thread` + `destination` に変換する。旧 `mode` と新しい2フィールドは同時指定できない。item-threadを使うhandler付きジョブは `CronContext.deliveryMode` に `item-thread` を指定する。`mail.ts` は配送方式を解釈せず、設定された `deliveryMode` / `sessionMode` を `enqueueCronInbox()` に渡す。各方式の投稿先準備・配送はcron enqueue/pollerの共通処理が担う。

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
- ジョブ定義の全フィールド（`id`, `schedule`, `groupName?`, `prompt?`, `channelId?`, `deliveryMode?`, `sessionMode?`, `noReply?`, `mode?`, `handler?`, `settings?`）を展開して渡す

複数項目を扱うhandlerは、各項目を `enqueueCronItemThread(ctx, content, { threadName })` で登録・provisioningできる。ただしこのhelperは非推奨で、handler側がpollerとの競合を含む利用責任を負う。宣言的な `item-thread` ジョブは通常の `enqueueCronInbox()` から投入され、投入ごとに新しいjob identityを作り、pollerがAI実行前にprovisioningする。item-threadのsource照合や完了ACKはcron基盤では行わず、必要ならhandler側で扱う。

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

メールハンドラーは未読メールを取得して本文とACK対象のメールIDをinboxへ投入する。AI・Discord delivery・deliveryModeに応じたスレッド作成はcron enqueue/pollerの共通処理へ任せ、mail.ts自体は配送方式を制限しない。全delivery chunkが`sent`になった後にだけメールを既読化する。

1. 未読メールを取得して本文を取得する。
2. `enqueueCronInbox()` にメールIDを付けてjobを投入する。`deliveryMode` / `sessionMode` はcron設定から共通処理へ渡され、`direct`・`new-thread`・`item-thread` のいずれも設定に応じて処理される。jobにはACK対象のメールID以外のmail固有冪等キーやsource照合情報を付けず、前回のjob・placeholder・スレッドを検索しない。
3. cron enqueue/pollerが設定された方式に従って投稿先を準備し、providerのconcurrency設定とセッション順序を保ったままAI・deliveryを実行する。`item-thread` ではAI実行前に仮メッセージと独立スレッドを確保する。
4. AIが成功し、生成された全delivery chunkが`sent`になった後にだけ対象メールを既読化する。

AI・Discord delivery・既読化のいずれかが失敗したメールは未読のまま残る。次回実行では過去jobを再開・照合せず新しいjobと投稿先を作るため、失敗した試行のDiscord投稿が残る場合は重複しうる。このjob境界の性質はmail固有の既知の残余リスクであり、RSS dispatchなど別目的の冪等性は維持する。

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
