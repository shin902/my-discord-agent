# cron 設計メモ

## 概要

定期実行ジョブの基盤。1分ごとに有効なジョブをチェックし、条件を満たせばエージェントへ投げる。

---

## ファイル構成

```
config/cron-jobs.json      # ジョブ定義
src/cron/
  runner.ts                # 1分ごとのスケジューラ（薄い実行基盤）
  jobs/
    mail.ts                # メール固有ジョブ（TSバインド方式）
    *.ts                   # 将来追加するジョブ
data/cron/
  state.json               # 各ジョブの lastRun を記録（重複実行防止）
```

---

## ジョブ定義（config/cron-jobs.json）

### 通常ジョブ（JSONだけで完結）

```json
[
  {
    "id": "daily-report",
    "schedule": "0 9 * * *",
    "groupName": "my-group",
    "prompt": "昨日のログを分析して日次レポートを作成してください",
    "channelId": "12345",
    "mode": "thread"
  }
]
```

### カスタムジョブ（TSファイルをバインド）

```json
[
  {
    "id": "mail-check",
    "schedule": "*/30 * * * *",
    "handler": "jobs/mail.ts"
  }
]
```

`handler` があるジョブは `prompt`・`channelId`・`mode` 省略可能。省略しない場合は `CronContext` 経由でハンドラーに渡される。

---

## フィールド定義

| フィールド | 必須 | 型 | 説明 |
|-----------|------|-----|------|
| `id` | ✓ | string | ジョブID（一意） |
| `schedule` | ✓ | string | cron式 `"0 9 * * *"` or インターバル `"30m"` `"1h"` |
| `groupName` | handler なし時必須 / handler あり時オプション | string | エージェントグループ名。handler ありジョブでも記載すれば `CronContext.groupName` 経由で参照できる |
| `prompt` | handler なし時必須 | string | エージェントへのプロンプト |
| `channelId` | handler なし時必須 | string | 送信先 Discord チャンネル ID |
| `mode` | handler なし時必須 | `"channel"` \| `"thread"` | 実行モード（後述） |
| `handler` | オプション | string | カスタムロジックの TS ファイルパス（`src/cron/` からの相対パス。`../` などパストラバーサルは正規表現で弾く） |

handlerが設定されてる場合、JSONの全フィールドは `CronContext` に詰めてハンドラーに渡す。"handler なし時必須" フィールドはhandlerありの場合オプション扱いになるが、記載すればハンドラーから参照できる。

### mode

| 値 | 動作 |
|----|------|
| `"channel"` | `appendInbox()` 経由でキューに積む。tick は即座に返る（非ブロッキング）。毎回独立したセッション |
| `"thread"` | スレッドを作成し `sendMessage()` でエージェント実行を直接 await する。エージェントが応答するまで tick が完了しない（ブロッキング）。スレッド ID を sessionId として使うため後続のスレッド会話でコンテキストが引き継がれる |

**`channel` vs `thread` の非対称性**: `channel` はキュー経由で即時返却、`thread` はエージェント完了まで await する。複数の `thread` ジョブが同一 tick で起動すると `Promise.allSettled` で並走し、全ジョブ完了まで tick がブロックされる。エージェント実行が長い場合（数分〜）は `channel` モードを検討すること。`_isRunning` フラグにより次の tick は前の tick が完了するまでスキップされる。

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
- ジョブ定義の全フィールド（`id`, `schedule`, `groupName?`, `prompt?`, `channelId?`, `mode?`, `handler?`）を展開して渡す

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

## メール処理との関係（issue #70）

メール確認ジョブはカスタムジョブ（TSバインド）として実装する。フロー：

```
cron（mail.ts）
  → メール確認（既存のメール系ツールを改変）
  → 新着なければ終了
  → LLMを呼んで要約生成（実装は mail.ts に委ねる。メール内容を扱うためローカルLLM推奨。ホスト側でSDK直接呼び出しを想定。システムプロンプトどうするかは検討中（AGENTS.mdを読む？））
  → Discord チャンネルに要約を投稿
  （以降は新しく作る email-mode に任せる。後述）
  → startThread() でスレッド作成
  → sessionId = {スレッドID} として JSONL を初期化。（ここは auto-thread のフローと同じ）その際に要約の文章と一緒にメールのIDもコンテキストに含める

以降は通常のDiscordの処理のフロー（後述）
  → ユーザーがスレッドに返信 → handler.ts → appendInbox → エージェントが応答
```

---

## email-mode（別設計・未実装）

cron 設計とは独立した新しいセッションモード。

**通常の auto-thread との違い**:

| | auto-thread | email-mode |
|--|-------------|-----------|
| トリガー | ユーザーのメッセージ | cron（外部イベント） |
| スレッド作成後 | エージェントが自動応答 | 自動応答なし |

---

## スコープ外（別途検討）

- **`allowedTools` / `allowedSkills`**: ジョブごとにグループ設定のツール・スキルをオーバーライドする機能（issue #73）。`InboxMessage` と `sendMessage` 両方への対応が必要なため別途実装。

- **Discord カスタムスラッシュコマンド**: cron のトグル、ローカル LLM の Heartbeat 制御など（issue #70）。

## 没・保留

- **`session: "fixed"`**: 実行間で会話履歴を持ち越す固定セッション方式。channelId を永続化するだけでは複数ジョブがセッションを共有してしまう問題があり、エージェントの最終的なレスポンスのみを共有するか、具体的なユースケースも固まらなかったため削除。

- **サーバーが落ちてた間のジョブ再実行**: 停止中に実行予定だったジョブを再起動時に自動実行する機能。`state.json` の `lastRun` に加えて「次の予定実行時刻」も記録する必要があり実装が複雑になるため保留。

- **Heartbeat**: 一定間隔でエージェントに話しかけ続けるユースケース。実行のたびにセッションが積み上がりコンテキストが肥大化するため cron 基盤では対応しない。必要であればカスタムジョブとしてエージェントに作成依頼することを推奨。
