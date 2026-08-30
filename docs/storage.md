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
      *.jsonl           # backup退避前だけ残るlegacy原本（fallbackには使わない）
  session-jsonl-backup/
    <date>/<batch>/<groupName>/*.jsonl  # migration時に退避したrollback用原本
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

queue worker・Discord intakeを開始する前のstartup migrationで、停止済みrunnerを待ってから設定済みの全groupを一括処理する。migrationにはinter-process lockがなく、groupごとの一時DB pathも固定のため、全instanceを停止して単一のstartup ownerだけで実行する。複数instanceの同時起動やrolling startupでmigrationを実行してはならない。groupごとに一時DBへlegacy `*.jsonl`をtransactional importし、同じtransactionで`legacy_jsonl_imported=1` markerを保存する。session/entry件数と`PRAGMA integrity_check`を検証し、file sync後に`sessions.sqlite`へatomic renameしてdirectoryをsyncする。JSONLがないgroupにもmarker付きDBを作る。

既存DBはschema・integrity・markerだけを検証する。marker付きDBと残存JSONLの内容は比較・mergeせず、markerがない、または不正なDBではcleanup前に起動を中止する。これは旧group単位lazy migrationのmarkerと互換である。

全groupのDBが完了した後、残存JSONLを`data/session-jsonl-backup/<date>/<unique-batch>/<groupName>/`へ同一filesystem上のrenameでbest effort退避する。個別の退避失敗（`EXDEV`を含む）はwarningとし、原本を残して通常起動を続け、次回起動で残件を別batchへ再試行する。backupはsandboxへmountされず、保持期間を確認後にoperatorが手動削除する。rollback用原本はmigration時点までしか含まず、SQLite稼働後の追記を旧binaryへ戻す無損失rollbackは保証しない。自動退避には`sessions/`とbackup directoryが同一filesystem上にある必要がある。

migration完了後はSQLiteだけをcanonicalとし、残存・退避済みJSONLへのfallback/dual-writeは行わない。旧binaryとのmixed-version運用は避ける。

DBはgroup directoryごとsandboxへmountされるため、他groupや`runtime.sqlite`は公開されない。DB backupは稼働停止中にcopyするかSQLite backup APIを使い、WAL運用へ変更した場合にmain fileだけをcopyしない。

## ファイル操作の方針

| ファイル | 形式 | 操作 |
|---|---|---|
| `config/config.json` / `credentials.json` / `groups.json` / `cron.json` | JSON | 起動時に読み込み、変更時は全書き直し |
| `data/sessions/<groupName>/sessions.sqlite` | SQLite | `sessions` identity + append-only `session_entries` |
| `data/queue/inbox.jsonl` | JSONL | shift/prepend（既存実装） |
