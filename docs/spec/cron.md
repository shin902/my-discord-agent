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

`handler` があるジョブは `prompt`・`channelId`・`output`・`session` 不要（TS側が全部管理）。

---

## フィールド定義

| フィールド | 必須 | 型 | 説明 |
|-----------|------|-----|------|
| `id` | ✓ | string | ジョブID（一意）。fixed セッションの ID にも使われる |
| `schedule` | ✓ | string | cron式 `"0 9 * * *"` or インターバル `"30m"` `"1h"` |
| `groupName` | handler なし時必須 | string | エージェントグループ名 |
| `prompt` | handler なし時必須 | string | エージェントへのプロンプト |
| `channelId` | handler なし時必須 | string | 送信先 Discord チャンネル ID |
| `allowedTools` | オプション（デフォルトでグループの設定、記述時はこっちにオーバーライド） | string[] | 有効なツール |
| `allowedSkills` | オプション（デフォルトでグループの設定、記述時はこっちにオーバーライド） | string[] | 有効なスキル |
| `mode` | handler なし時必須 | `"channel"` \| `"thread"` \| `"fixed"` | 実行モード（後述） |
| `handler` | オプション | string | カスタムロジックの TS ファイルパス |

handlerが設定されてる場合、JSONの "handler なし時必須"、"オプション"は無視する方針

### mode

| 値 | 動作 |
|----|------|
| `"channel"` | 指定チャンネルに `channel.send()` するだけ。毎回独立、セッションなし |
| `"thread"` | `channel.threads.create({ name: cron-jobId })` でスレッドを作成し `thread.send(結果)` で投稿。スレッドID を sessionId として使う。`thread.send()` は `MessageCreate` を発火するが bot 発言のため `handler.ts` が無視し JSONL には自動で記録されない。後続の会話でエージェントにコンテキストを持たせたいので、 `appendMessage(groupName, thread.id, { role: "assistant", content: 結果 })` を明示的に呼ぶ |

---

## TSバインドジョブのインターフェース

```typescript
// src/cron/jobs/mail.ts
export default async function handler(ctx: CronContext): Promise<void> {
  // ctx に client, appendInbox などが入る
}
```

`CronContext` に含めるもの（未確定）:
- Discord `client`
- `appendInbox`
- `groupName`（ジョブ定義から渡す）

---

## スケジュール形式

- **cron式**: `"0 9 * * *"` — 分・時・日・月・曜日。標準的な cron 記法
- **インターバル**: `"30m"` `"1h"` `"2h"` — 起動からの経過時間ベース

**重複実行防止**: `data/cron/state.json` に各ジョブの `lastRun` を記録。チェック条件は `前回実行時刻 < 今回の予定実行時刻 ≤ 現在時刻`。これにより cron式 `0 9 * * *` が 9:00〜9:59 の間に何度もマッチする問題を防ぐ。

---

## メール処理との関係（issue #70）

メール確認ジョブはカスタムジョブ（TSバインド）として実装する。フロー：

```
cron（mail.ts）
  → メール確認（既存のメール系ツールを改変）
  → 新着なければ終了
  → ホスト側でLLMを呼んで要約生成（セッションなし、使い捨て。システムプロンプトをどうするかは要検討）
  → Discord チャンネルに要約を投稿
  （以降は新しく作る email-mode に任せる）
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

- **Heartbeat**: 一定間隔でエージェントに話しかけるユースケース。毎回セッションが積み上がりコンテキストが肥大化するため、cron 基盤では対応しない。それ専用のカスタムジョブをエージェントに作成依頼することを推奨

- **Discord カスタムスラッシュコマンド**: cron のトグル、ローカル LLM の Heartbeat 制御など（issue #70）。
