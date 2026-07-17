# ストレージ設計

設定データとシーケンシャルデータで形式を使い分ける。

## ディレクトリ構造

```
config/
  config.json           # defaultModel / proxy / agent 設定（人が直接編集する）
  providers.json        # AI provider ごとの同時実行ポリシー（省略可）
  credentials.json      # AI プロバイダー・外部サービスの接続設定
  groups.json           # チャンネル→グループのマッピング＋エージェント設定
  cron.json             # 定期実行ジョブ定義（省略可）

data/
  sessions/
    <groupName>/
      <sessionId>.jsonl # 会話履歴（1行1メッセージ、追記のみ）
  queue/
    inbox.jsonl         # メッセージキュー（既存実装）
    dead-letter.jsonl   # 処理失敗メッセージ（既存実装）

groups/
  <folder>/
    AGENTS.md           # グループ固有の指示・メモリ
```

## config/groups.json

> 参考: `docs/clone/VRC-AI-Bot/implementation/src/config/load-config.ts`
> VRC-AI-Bot の `watch-locations.json` と同じアプローチ

```json
[
  {
    "name": "dev",
    "channels": [
      { "channelId": "111", "sessionMode": "shared" },
      { "channelId": "222", "sessionMode": "thread" }
    ]
  },
  {
    "name": "general",
    "channels": [
      { "channelId": "333", "sessionMode": "auto-thread" }
    ]
  }
]
```

- `groups[].name` がグループフォルダ名（`groups/<name>/`）と対応
- 起動時に Zod でバリデーション

各設定ファイルの詳細は `docs/config.md` を参照。

## ファイル操作の方針

| ファイル | 形式 | 操作 |
|---|---|---|
| `config/config.json` / `credentials.json` / `groups.json` / `cron.json` | JSON | 起動時に読み込み、変更時は全書き直し |
| `data/sessions/<groupName>/<sessionId>.jsonl` | JSONL | 追記のみ（既存実装） |
| `data/queue/inbox.jsonl` | JSONL | shift/prepend（既存実装） |
