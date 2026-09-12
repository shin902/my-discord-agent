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
  runtime.sqlite        # host所有のqueue・delivery・採用会話参照・idempotency・admission・Discord cursor
  runtime.sqlite-wal    # runtime DBのWAL（存在する場合）
  runtime.sqlite-shm    # runtime DBの共有メモリ（存在する場合）
  rss.sqlite3           # RSS収集・dispatch状態（runtime DBとは別）
  screen-captures.sqlite # host専用の画面PNG BLOB・受信時刻・要約（NULLなら未読）
  memory-export.sqlite  # backend/group/sourceごとのexport成功markerのみ
  sessions/
    <groupName>/
      sessions.sqlite   # group単位のcanonical session trajectory
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
| `jobs` | 入力payload、実行状態、lease・fencing、結果、Bot同期実行のadmission。`delivery_suppressed` は結果commit時に配送を意図的に抑制した成功を表す |
| `deliveries` | Discordへ送るchunkと配送状態 |
| `committed_conversations` | 結果commit時に採用したgroup + user/assistant entry ID。本文は持たず、jobs retentionと独立して保持 |
| `idempotency_keys` | 受理済み・完了済み入力の冪等性 |
| `dead_letters` | 処理不能・移行不正行などの記録 |
| `discord_sync_cursors` | Discord履歴backfillの進行位置 |
| `bot_task_sessions` | Bot Task Sessionのidentity・所有関係 |
| `schema_meta` | schema versionと旧queue移行marker |

runtime DBはWALを使用します。稼働中にmain fileだけをコピーしないでください。[backup.ts](../src/queue/backup.ts) はSQLiteのserializeで整合したsnapshotを作り、別DBとしてread-onlyで開いてintegrityを検証します。session DBやRSS DB、workspace、認証stateまで含む一括backupではありません。

`jobs.delivery_suppressed=1` は `<NO_REPLY>` など、結果は成功だがDiscord deliveryを意図的に作らない完了をdurably識別するruntime metadataです。RSS claimのreconciliationはこのフラグを成功根拠として使いますが、通常のdeliveryが0件になっただけでは既読化しません。既存runtime DBは起動時のschema migrationでこの列を追加します。

`committed_conversations`はruntime schema v7で追加されます。既存のfenced結果commitと同一transactionで保存し、jobsへの削除連動FKは設けません。参照の自動削除期限はなく、source lifecycleに沿った明示的な廃棄まで保持します。通常queue retentionはこのtableを削除しません。既存成功jobやraw trajectoryからの参照backfillは行いません。

実データの調査は [runtime-dbスキル](../.pi/skills/runtime-db/SKILL.md) のread-only手順を使ってください。通常の完了・retention・recoveryを、JSONL行の削除やad-hoc SQLで代用しないでください。

### 旧queue JSONLの移行（現行の起動処理）

[migration.ts](../src/queue/migration.ts) は旧 `data/queue/inbox.jsonl` と `dead-letter.jsonl` が存在する場合に読みます。元データを `data/queue/archive/` へcopyし、内容を検証して読み取り専用にしてから、ファイル単位のtransactionでimportします。ファイル名と内容hashのmarkerにより同じ内容の再importを避けます。

未完了入力はjobsへ、完了済み入力の冪等性はidempotency_keysへ、旧dead-letterや不正行はdead_lettersへ記録します。元JSONLはこの処理では削除・移動しません。runtimeは以後SQLiteへ書き込み、JSONLへのdual-writeやfallbackは行いません。旧JSONLが残っていても処理待ちqueueの正本として編集しないでください。

## Session trajectory

session historyは`runtime.sqlite`へ統合せず、AgentGroupごとの`sessions.sqlite`に保存する。`runtime.sqlite`はqueue・delivery・admission等のControl Plane、session DBはconversation/task trajectoryのData Planeである。session storeはSQLiteのversioned schemaを使い、`sessions`でidentityを管理し、`session_entries`へメッセージをappendする。

DBはgroup directoryごとsandboxへmountされるため、他groupや`runtime.sqlite`は公開されない。DB backupは稼働停止中にcopyするかSQLite backup APIを使い、WAL運用へ変更した場合にmain fileだけをcopyしない。

`session_entries.source_json` はMemoryと独立したnullableなuser entryのsource provenanceです。通常human Discord messageのsourceを保存し、LLM contextには含めません。schema v4ではMemory専用になっていたv3の `execution_json` と検索indexを削除します。v1/v2からも通常session書き込み時にv4へ更新し、既存entry ID・本文・sourceを保持します。migrationはwrite lock下でversionを再確認します。

append APIはgroup DB内でstableなentry IDを返します。Runnerは入力user / final assistantのIDをhostへ返し、runtimeの採用参照が確定した後、exporterは指定entry本文だけをread-onlyで取得します。session renameはentry IDを変えず、参照のsession ID更新は不要です。旧履歴や存在しないDBを補完・作成しません。export / re-exportにはsession DBとruntime内の採用参照の両方をbackup・保持してください。group DBを削除・再作成する際はID再利用を避けるため古い採用参照を残さない運用が必要です。host / runnerの同時更新と旧方式からの移行制限は [Agent Memory export](agent-memory.md#attempt照合方式からのrollout) を参照してください。

実装の正本は [session.ts](../src/agent/session.ts) です。

## Screen captures

`data/screen-captures.sqlite`は画像本体と未読状態を一緒に保存するhost専用DBです。`summary IS NULL`を未読の正本とし、要約保存と既読化を1つのSQL更新で確定します。WAL運用のため稼働中のmain file単独copyは避け、SQLite backup APIを使用してください。runtime DB backupには含まれません。設定・schema・Mac送信・retentionは [画面画像の収集と要約](screen-capture.md) を参照してください。

## Memory export ledger

`data/memory-export.sqlite` は `(backend_id, group_name, source_kind, source_id)` ごとの `exported_at` だけを持つprojectionです。queue・retry・lease等はruntime DBの責務であり、本文や設定のcopyは置きません。runtime DB backupには含まれません。稼働停止中のcopyまたはSQLite backup APIを使い、ledgerのみを消して既存backendへ再送すると重複し得る点に注意してください。再構築・運用は [Agent Memory export](agent-memory.md) を参照してください。
