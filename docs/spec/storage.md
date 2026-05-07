# ストレージ設計

設定データとシーケンシャルデータで形式を使い分ける。

## ディレクトリ構造

```
config/
  groups.json           # グループ・チャンネル・配線の設定（人が直接編集する）

data/
  sessions/
    <groupName>/
      <sessionId>.jsonl # 会話履歴（1行1メッセージ、追記のみ）
  queue/
    inbox.jsonl         # メッセージキュー（既存実装）
    dead-letter.jsonl   # 処理失敗メッセージ（既存実装）

groups/
  <folder>/
    CLAUDE.local.md     # グループ固有の指示・メモリ
    group.json      # MCP・マウント・ツール・モデル設定
```

## `config/groups.json`

グループ・チャンネル・配線をひとつのファイルに集約する。

> 参考: `docs/clone/VRC-AI-Bot/implementation/src/config/load-config.ts`
> VRC-AI-Bot の `watch-locations.json` と同じアプローチ

```json
{
  "groups": [
    {
      "id": "g-dev",
      "name": "開発",
      "folder": "dev",
      "channels": [
        {
          "channelId": "111",
          "name": "dev-chat",
          "sessionMode": "shared"
        },
        {
          "channelId": "222",
          "name": "dev-threads",
          "sessionMode": "thread"
        }
      ]
    },
    {
      "id": "g-general",
      "name": "汎用",
      "folder": "general",
      "channels": [
        {
          "channelId": "333",
          "name": "general",
          "sessionMode": "auto-thread"
        }
      ]
    }
  ]
}
```

起動時に Zod でバリデーション。`channelId` の重複はエラー。

## ファイル操作の方針

| ファイル | 形式 | 操作 |
|---|---|---|
| `config/groups.json` | JSON | 起動時に読み込み、変更時は全書き直し |
| `data/sessions/<groupName>/<sessionId>.jsonl` | JSONL | 追記のみ（既存実装） |
| `data/queue/inbox.jsonl` | JSONL | shift/prepend（既存実装） |
