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
    "output": "thread",
    "session": "new"
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
| `groupName` | ✓ | string | エージェントグループ名 |
| `prompt` | handler なし時必須 | string | エージェントへのプロンプト |
| `channelId` | handler なし時必須 | string | 送信先 Discord チャンネル ID |
| `output` | オプション | `"thread"` \| `"channel"` | 結果の返し方（後述） |
| `session` | オプション | `"new"` \| `"fixed"` | セッション方針（後述） |
| `handler` | オプション | string | カスタムロジックの TS ファイルパス |

### output

- `"thread"` → 結果投稿後に `startThread()` でスレッドを作成。そのスレッドをセッションに紐付け
- `"channel"` → 指定チャンネルに `channel.send()` するだけ

### session

- `"new"` → 毎回新規セッション（スレッド作成と組み合わせることが多い）
- `"fixed"` → `cron-{id}` の固定 sessionId を使い、実行間で会話履歴を持ち越す

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

重複実行防止は `data/cron/state.json` に各ジョブの `lastRun` を記録して管理。

---

## メール処理との関係（issue #70）

メール確認ジョブはカスタムジョブ（TSバインド）として実装する。フロー：

```
cron（mail.ts）
  → メール確認（既存のメール系ツール）
  → 新着なければ終了
  → ホスト側でLLMを呼んで要約生成（セッションなし、使い捨て）
  → Discord チャンネルに要約を投稿
  → startThread() でスレッド作成
  → sessionId = "mail-{mailId}" として JSONL を初期化

以降は mail-mode のフロー（後述）
  → ユーザーがスレッドに返信 → handler.ts → appendInbox → エージェントが応答
```

---

## mail-mode（別設計・未実装）

cron 設計とは独立した新しいセッションモード。

**通常の auto-thread との違い**:

| | auto-thread | mail-mode |
|--|-------------|-----------|
| トリガー | ユーザーのメッセージ | cron（外部イベント） |
| スレッド作成後 | エージェントが自動応答 | 自動応答なし |
| sessionId | スレッドID | `mail-{mailId}` |

処理内容: メッセージ投稿 → スレッド作成 → セッション JSONL 作成のみ。`autoReply: false` とは別物。

---

## スコープ外（別途検討）

- **Heartbeat**: 一定間隔でエージェントに話しかけるユースケース。毎回セッションが積み上がりコンテキストが肥大化するため、cron 基盤では対応しない。別の方式を検討。
- **Discord カスタムスラッシュコマンド**: cron のトグル、ローカル LLM の Heartbeat 制御など（issue #70）。
