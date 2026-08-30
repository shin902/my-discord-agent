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
      sessions.sqlite   # group単位のcanonical session trajectory
      *.jsonl           # migration後もrollback/監査用に残すlegacy原本
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

## Session trajectory

session historyは`runtime.sqlite`へ統合せず、AgentGroupごとの`sessions.sqlite`に保存する。`runtime.sqlite`はqueue・delivery・admission等のControl Plane、session DBはconversation/task trajectoryのData Planeである。

初回アクセス時に同じgroup directoryのlegacy `*.jsonl`をtransaction内で一度だけimportする。壊れた行があればfile/lineを示して全importをrollbackし、原本は変更・削除しない。import完了後はSQLiteだけをcanonicalとし、残存JSONLへfallback/dual-writeしない。旧binaryとのmixed-version運用は避ける。

DBはgroup directoryごとsandboxへmountされるため、他groupや`runtime.sqlite`は公開されない。backupは稼働停止中にDBをcopyするかSQLite backup APIを使い、WAL運用へ変更した場合にmain fileだけをcopyしない。

## ファイル操作の方針

| ファイル | 形式 | 操作 |
|---|---|---|
| `config/config.json` / `credentials.json` / `groups.json` / `cron.json` | JSON | 起動時に読み込み、変更時は全書き直し |
| `data/sessions/<groupName>/sessions.sqlite` | SQLite | `sessions` identity + append-only `session_entries` |
| `data/queue/inbox.jsonl` | JSONL | shift/prepend（既存実装） |
