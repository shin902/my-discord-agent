# ストレージ設計

この文書は保存先とデータ移行の現行仕様です。キューの状態・実行・配送は [永続キュー](inbox-queue.md)、設定schemaは [設定リファレンス](config.md) を参照してください。

## ディレクトリ構造

```
config/
  config.json           # defaultModel / proxy / agent 設定（人が直接編集する）
  bots.json             # Agent Bot Registry（省略可）
  providers.json        # AI provider ごとの同時実行ポリシー（省略可）
  credentials.json      # AI プロバイダー・外部サービスの接続設定
  groups.json           # チャンネル→グループのマッピング＋エージェント設定
  cron.json             # 定期実行ジョブ定義（省略可）

data/
  runtime.sqlite        # host所有のqueue・delivery・idempotency・admission・Discord cursor
  runtime.sqlite-wal    # runtime DBのWAL（存在する場合）
  runtime.sqlite-shm    # runtime DBの共有メモリ（存在する場合）
  rss.sqlite3           # RSS収集・dispatch状態（runtime DBとは別）
  sessions/
    <groupName>/
      sessions.sqlite   # group単位のcanonical session trajectory
      *.jsonl           # backup退避前だけ残るlegacy原本（fallbackには使わない）
  session-jsonl-backup/
    <date>/<batch>/<groupName>/*.jsonl  # migration時に退避したrollback用原本
  queue/
    inbox.jsonl         # 旧形式の移行入力だけ。現行queueではない
    dead-letter.jsonl   # 旧形式の移行入力だけ
    archive/*.bak       # queue migration時に作る読み取り専用backup

groups/
  <groupName>/
    AGENTS.md           # グループのシステムプロンプト
    SKILLS/             # グループのスキル
    memory/             # MEMORY.md / SELF.md等のグループ内ファイル
```

これは主要な保存先の一覧です。設定ファイルの内容・上書き環境変数は [config.md](config.md)、RSSの保存先設定は [RSS設定スキル](../.pi/skills/config-rss/SKILL.md)、認証用private stateは [proxy.md](proxy.md) を参照してください。`groups[].name` が `groups/<groupName>/` と対応します。

## Runtime database

`data/runtime.sqlite` がqueue・deliveryの唯一の永続正本です。`RUNTIME_DB_PATH` で上書きでき、相対パスはプロジェクトルート基準です。実装は [repository.ts](../src/queue/repository.ts) にあります。

| テーブル | 責務 |
|---|---|
| `jobs` | 入力payload、実行状態、lease・fencing、結果、Bot同期実行のadmission |
| `deliveries` | Discordへ送るchunkと配送状態 |
| `idempotency_keys` | 受理済み・完了済み入力の冪等性 |
| `dead_letters` | 処理不能・移行不正行などの記録 |
| `discord_sync_cursors` | Discord履歴backfillの進行位置 |
| `bot_task_sessions` | Bot Task Sessionのidentity・所有関係 |
| `schema_meta` | schema versionと旧queue移行marker |

runtime DBはWALを使用します。稼働中にmain fileだけをコピーしないでください。[backup.ts](../src/queue/backup.ts) はSQLiteのserializeで整合したsnapshotを作り、別DBとしてread-onlyで開いてintegrityを検証します。session DBやRSS DB、workspace、認証stateまで含む一括backupではありません。

実データの調査は [runtime-dbスキル](../.pi/skills/runtime-db/SKILL.md) のread-only手順を使ってください。通常の完了・retention・recoveryを、JSONL行の削除やad-hoc SQLで代用しないでください。

### 旧queue JSONLの移行（現行の起動処理）

[migration.ts](../src/queue/migration.ts) は旧 `data/queue/inbox.jsonl` と `dead-letter.jsonl` が存在する場合に読みます。元データを `data/queue/archive/` へcopyし、内容を検証して読み取り専用にしてから、ファイル単位のtransactionでimportします。ファイル名と内容hashのmarkerにより同じ内容の再importを避けます。

未完了入力はjobsへ、完了済み入力の冪等性はidempotency_keysへ、旧dead-letterや不正行はdead_lettersへ記録します。元JSONLはこの処理では削除・移動しません。runtimeは以後SQLiteへ書き込み、JSONLへのdual-writeやfallbackは行いません。旧JSONLが残っていても処理待ちqueueの正本として編集しないでください。

## Session trajectory

session historyは`runtime.sqlite`へ統合せず、AgentGroupごとの`sessions.sqlite`に保存する。`runtime.sqlite`はqueue・delivery・admission等のControl Plane、session DBはconversation/task trajectoryのData Planeである。

queue worker・Discord intakeを開始する前のstartup migrationで、停止済みrunnerを待ってから設定済みの全groupを一括処理する。migrationにはinter-process lockがなく、groupごとの一時DB pathも固定のため、全instanceを停止して単一のstartup ownerだけで実行する。複数instanceの同時起動やrolling startupでmigrationを実行してはならない。groupごとに一時DBへlegacy `*.jsonl`をtransactional importし、同じtransactionで`legacy_jsonl_imported=1` markerを保存する。session/entry件数と`PRAGMA integrity_check`を検証し、file sync後に`sessions.sqlite`へatomic renameしてdirectoryをsyncする。JSONLがないgroupにもmarker付きDBを作る。

既存DBはschema・integrity・markerだけを検証する。marker付きDBと残存JSONLの内容は比較・mergeせず、markerがない、または不正なDBではJSONL退避前に起動を中止する。runnerの停止確認はmigrationより先に行う。これは旧group単位lazy migrationのmarkerと互換である。

全groupのDBが完了した後、残存JSONLを`data/session-jsonl-backup/<date>/<unique-batch>/<groupName>/`へ同一filesystem上のrenameでbest effort退避する。個別の退避失敗（`EXDEV`を含む）はwarningとし、原本を残して通常起動を続け、次回起動で残件を別batchへ再試行する。backupはsandboxへmountされず、保持期間を確認後にoperatorが手動削除する。rollback用原本はmigration時点までしか含まず、SQLite稼働後の追記を旧binaryへ戻す無損失rollbackは保証しない。自動退避には`sessions/`とbackup directoryが同一filesystem上にある必要がある。

migration完了後はSQLiteだけをcanonicalとし、残存・退避済みJSONLへのfallback/dual-writeは行わない。旧binaryとのmixed-version運用は避ける。

DBはgroup directoryごとsandboxへmountされるため、他groupや`runtime.sqlite`は公開されない。DB backupは稼働停止中にcopyするかSQLite backup APIを使い、WAL運用へ変更した場合にmain fileだけをcopyしない。

実装の正本は [session.ts](../src/agent/session.ts) です。旧JSONLの設計は移行理由を説明するための背景であり、現行の保存形式ではありません。
