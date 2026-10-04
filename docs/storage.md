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
  screen-captures.sqlite # host専用の画面PNG BLOB・撮影時刻・処理完了時刻
  memory-export.sqlite  # backend/group/sourceごとのexport成功markerのみ
  sessions/
    <groupName>/
      sessions.sqlite   # group単位のcanonical session trajectory
  queue/
    *.jsonl             # 旧queueの残存ファイル（現行runtimeは読み込まない）

groups/
  <groupName>/
    AGENTS.md           # グループのシステムプロンプト
    SKILLS/             # グループのスキル
    memory/             # MEMORY.md / SELF.md等のグループ内ファイル
    agent-memory/       # owner別Markdown。本文の正本（既存workspace共有）
```

これは主要な保存先の一覧です。設定ファイルの内容・上書き環境変数は [config.md](config.md)、RSSの保存先設定は [RSS設定スキル](../.pi/skills/config-rss/SKILL.md)、認証用private stateは [proxy.md](proxy.md) を参照してください。`groups[].name` が `groups/<groupName>/` と対応します。

## Runtime database

`data/runtime.sqlite` がqueue・deliveryの唯一の永続正本です。`RUNTIME_DB_PATH` で上書きでき、相対パスはプロジェクトルート基準です。実装は [repository.ts](../src/queue/repository.ts) にあります。

| テーブル | 責務 |
|---|---|
| `jobs` | 入力payload、実行状態、lease・fencing、結果、Bot同期実行のadmission。`delivery_suppressed` は無配信成功、`source_kind` / `allow_failed_predecessor` は登録済みsourceの識別と配送順序policyを表す |
| `deliveries` | Discordへ送るchunkと配送状態 |
| `committed_conversations` | 結果commit時に採用したgroup + user/assistant entry ID。本文は持たず、jobs retentionと独立して保持 |
| `idempotency_keys` | 受理済み・完了済み入力の冪等性 |
| `dead_letters` | 処理不能な入力などの記録 |
| `discord_sync_cursors` | Discord履歴backfillの進行位置 |
| `bot_task_sessions` | Bot Task Sessionのidentity・所有関係 |
| `mail_threads` | `groupName + channelId + mailRouteKey` から再利用するMail専用Discord thread IDへのmapping。schema v8で追加 |
| `schema_meta` | schema versionとIssue #540変換marker |

runtime DBはWALを使用します。稼働中にmain fileだけをコピーしないでください。[backup.ts](../src/queue/backup.ts) はSQLiteのserializeで整合したsnapshotを作り、別DBとしてread-onlyで開いてintegrityを検証します。session DBやRSS DB、workspace、認証stateまで含む一括backupではありません。

`jobs.delivery_suppressed=1` は `<NO_REPLY>` など、結果は成功だがDiscord deliveryを意図的に作らない完了をdurably識別するruntime metadataです。RSS claimのreconciliationはこのフラグを成功根拠として使いますが、通常のdeliveryが0件になっただけでは既読化しません。既存runtime DBは起動時のschema migrationでこの列を追加します。

`committed_conversations`はruntime schema v7で追加されます。既存のfenced結果commitと同一transactionで保存し、jobsへの削除連動FKは設けません。参照の自動削除期限はなく、source lifecycleに沿った明示的な廃棄まで保持します。通常queue retentionはこのtableを削除しません。既存成功jobやraw trajectoryからの参照backfillは行いません。

runtime schema v10は採用参照にもnullableな `delivery_suppressed` を追加し、結果commitと同時に配信可否を保存します。queue retention後も `historyMode: "final-only"` が配信抑制された結果を除外できます。既存行はNULLのまま保持し、final-only contextには採用しません（Memory exportの採用参照には従来どおり含まれます）。起動時の既存migration経路で追加され、session DB schemaはv6のままです。HostとRunner imageを同じcheckoutからbuildして再起動してください。

実データの調査は [runtime-dbスキル](../.pi/skills/runtime-db/SKILL.md) のread-only手順を使ってください。通常の完了・retention・recoveryを、JSONL行の削除やad-hoc SQLで代用しないでください。

### Issue #540 一回限りのruntime変換

新runtimeはMail/RSSの旧top-level IDを処理せず、旧queue JSONLも起動時には読みません。schema v9は`jobs.source_kind`と`allow_failed_predecessor`を追加し、Mail/RSSのfeature envelopeを配送まで永続化します。旧DBを持つ環境では**旧workerを停止**し、SQLite online backupまたは停止中のDB一式のcopy（WAL/SHMを含む）を取得してから、同じcheckoutで一回だけ次を実行します。旧workerと新workerを同じqueueで並走させないでください。

```bash
# サービス停止・バックアップ完了後。DBパスは実環境のものを明示する。
pnpm exec tsx scripts/convert-issue540-runtime.ts data/runtime.sqlite
pnpm build
pnpm start
```

systemd等で管理している環境では`pnpm start`を二重起動せず、変換・build後に管理サービスを起動します。起動ログでDiscord backfill完了後にworker/cronが開始したこと、および旧payloadが残らないことを確認します。

[converter](../scripts/convert-issue540-runtime.ts) は旧queue JSONLを取り込まず、既存SQLite内の`jobs`・`deliveries`・`dead_letters`のMail/RSS入力をfeature envelopeへ短いSQLite transactionで変換し、queueのlease/fencing/status、idempotency、session ID、採用会話参照を保持します。RSSの別DB、Screen Capture、group session DB、Memory ledgerは変更しません。外部APIへの呼び出しは変換中にありません。再実行は拒否されます。変換が失敗した場合は新workerを起動せず、バックアップとエラーを確認してください。旧JSONLファイルを残しても新runtimeには再流入しません。カスタムRSS statePathを設定から外しqueue側にも参照がなくなったclaimは自動発見できないため、運用で確認してください。

## Session trajectory

session historyは`runtime.sqlite`へ統合せず、AgentGroupごとの`sessions.sqlite`に保存する。`runtime.sqlite`はqueue・delivery・admission等のControl Plane、session DBはconversation/task trajectoryのData Planeである。session storeはSQLiteのversioned schemaを使い、`sessions`でidentityを管理し、`session_entries`へメッセージをappendする。

[clear / compact](spec/session-context.md) は旧sessionを退避IDへrenameしてから元IDをfresh/checkpointで置き換える。raw entry IDと採用会話参照は維持し、recent履歴はcheckpoint内に保持してraw会話の二重登録を避ける。schema v6のままで新規table・一括変換は不要。

DBはgroup directoryごとsandboxへmountされるため、他groupや`runtime.sqlite`は公開されない。DB backupは稼働停止中にcopyするかSQLite backup APIを使い、WAL運用へ変更した場合にmain fileだけをcopyしない。

`session_entries.source_json` はMemoryと独立したnullableなuser entryのsource provenanceです。通常human Discord messageのsourceを保存し、LLM contextには含めません。schema v6では同じgroup内の論理session identityは `(agent_id,id)`、entry所属は `(agent_id,session_id)` 複合FKです。v5で導入した`sessions.agent_id`はgroup内のownerの正本で、未設定の通常会話は`main`、Botを設定したchannel会話・cron・Bot TaskはBot IDです。Bot registryからBotを削除しても保存済みownerは変えません。`bot_task_sessions`はTaskのadmission/list/resume用であり、実行時のowner照合には使用しません。owner別のread-only trajectoryはuser entryを持つsessionだけをgroup DB内でsession作成時刻・ID、entry sequence順に走査します。未公開のsnapshot-only Bot sessionは含めません。既存sessionへの追記・renameはownerを変更しません。

**v4→v5導入手順:** 稼働中のすべてのgroup DBの`PRAGMA user_version`をread-onlyで確認し、v4以外は変換せず運用者に扱いを確認してください。runtime/runnerを停止し、runtime DBと全group DBをWALを含めSQLite整合バックアップします。停止状態のまま`pnpm exec tsx scripts/convert-issue556-session-owners.ts <runtime.sqlite> <sessions-root>`を明示したパスで一度だけ実行し、各DBのversion・owner別件数・削除された未登録`bot-task-<UUID>`とentryをバックアップと照合します。登録済みBot Task（registryから削除されたBotも含む）は保持し、非該当IDは`main`のままです。旧Bot ID `main`がruntime DBにある場合は変換前に明示エラーとして停止します。groupごとのtransactionであり全group間のatomicityはありません。途中失敗時は停止を維持し、**全DBをバックアップから復元してから**再実行します。変換済みDBと旧runtimeを混在起動せず、同じcheckoutでRunner imageをbuild/pushし、Hostもbuildしてから起動してください（`pnpm build`だけではRunner imageは更新されません）。新runtimeはv4以前を自動移行しません。

```bash
pnpm exec tsx scripts/convert-issue556-session-owners.ts data/runtime.sqlite data/sessions
# DB・owner件数・削除候補を照合してから、同じcheckoutで:
pnpm sandbox build  # Agent Runnerをbundleしlocalhost:5050のregistryへpush
pnpm build          # Hostをbuild
pnpm start          # または管理サービスを起動
```

**v5→v6導入手順 (#568):** 旧worker/Runnerを停止し、runtime DBと全group session DBをSQLite整合バックアップします。各group DBがv5であること・owner/entry件数・既存採用entry IDを確認し、停止状態のまま `pnpm exec tsx scripts/convert-issue568-session-identity.ts <sessions-root>` を一度だけ実行します。converterは全groupを先に検証し、groupごとのtransactionで複合PK/FKへrebuildします。旧entry IDと削除済みIDを含む `sqlite_sequence` の到達値を保持し、runtime DBには書き込みません。全groupの `PRAGMA user_version=6`, `foreign_key_check`, `integrity_check`、owner別件数、採用参照をバックアップと照合してください。途中失敗時は停止を維持し、**runtime DBを含む全DBを同じバックアップ一式から復元**してください。DBをv6へ変換後、再起動前に各groupへ配置済みの `session-logs` / `interest-profile` Skill（`interest-profile/scripts/extract_interests.py` を含む）を `templates/SKILLS/` とdiffしてください。`ensureGroupSkills()` は既存Skillを上書きしないため、未カスタマイズならtemplateで更新し、カスタマイズ済みならowner-awareなSQL・cursor key・state schema v4への変更だけを手動反映します。旧SQLを残したままv6 DBへアクセスさせないでください。v5とv6のHost/Runnerを並走させず、同じcheckoutでRunner imageをbuild/push、Hostをbuildしてから再起動します。v5は通常起動でもMemory exportでも拒否され、runtime fallbackはありません。

source付きappendは同じwrite transaction内で `(agent_id, session_id, source.kind, source.sourceId)` を照合し、重複なら本文・時刻を変更せず元のentry IDを返します。[appendUserOnly](spec/channel-modes.md#appenduseronly)もこの既存schemaへのappendを使います。

append APIはgroup DB内でstableなentry IDを返します。Runnerは入力user / final assistantのIDをhostへ返し、runtimeの採用参照が確定した後、exporterは指定entry本文だけをread-onlyで取得します。ownerを指定したsession renameは複合FKのCASCADEでentry IDを変えず、参照のsession ID更新は不要です。旧履歴や存在しないDBを補完・作成しません。export / re-exportにはsession DBとruntime内の採用参照の両方をbackup・保持してください。group DBを削除・再作成する際はID再利用を避けるため古い採用参照を残さない運用が必要です。host / runnerの同時更新と旧方式からの移行制限は [Agent Memory export](agent-memory.md#attempt照合方式からのrollout) を参照してください。

cron jobの [`historyMode: "final-only"`](spec/cron.md#final-only-historymode) はsession DBを変更せず、`src/features/session-context/` が採用済み参照から同じowner/sessionのfinal本文だけをread-onlyで選び、汎用のprojected historyとしてsandboxへ渡します。raw trajectoryと初期snapshotは保持され、LLMへ渡す過去run履歴だけを置き換えます。finalとrunの対応は `committed_conversations.turn_id` とstable assistant entry IDで追跡できます。旧履歴の推測backfillは行いません。

runtimeの `conversationPath` はMainでは従来の `data/sessions/<group>/sessions.sqlite#session=<id>`、Bot ownerでは末尾に `&agent=<URLエンコードしたBot ID>` を付ける。既存の保存済みmetadataは書き換えない。

`initial-agent-memory` custom entryはowner別Markdownの初回選択結果（空・失敗を含む）と実際の注入snapshotを保存します。実ユーザー発言とは区別し、resumeでは保存済み内容を再利用します。Agent Memory無効時は新規snapshotを作らず、保存済みsnapshotの保持・再生は維持します。既存schema v6を使い、role snapshotの有無とは独立して判定します。仕様は [Agent Memory](agent-memory.md#owner別markdownと新規sessionの初回選択) を参照してください。

実装の正本は [session.ts](../src/agent/session.ts) です。

## Screen captures

`data/screen-captures.sqlite`は画像本体、VLM要約、処理状態を一緒に保存するhost専用DBです。`completed_at IS NULL`を未完了の正本とし、full batch全体の通常Agent処理が成功した後に完了時刻を保存します。WAL運用のため稼働中のmain file単独copyは避け、SQLite backup APIを使用してください。`screen_capture_days` は画像GCと独立した受信撮影日（JST）、`screen_capture_daily_progress` はgroupごとの最後の日次生成成功日を保存します。runtime DB backupには含まれません。設定・schema・Mac送信・retentionは [画面画像の収集と要約](screen-capture.md) を参照してください。

## Memory export ledger

`data/memory-export.sqlite` は `(backend_id, group_name, source_kind, source_id)` ごとの `exported_at` だけを持つprojectionです。queue・retry・lease等はruntime DBの責務であり、本文や設定のcopyは置きません。runtime DB backupには含まれません。稼働停止中のcopyまたはSQLite backup APIを使い、ledgerのみを消して既存backendへ再送すると重複し得る点に注意してください。再構築・運用は [Agent Memory export](agent-memory.md) を参照してください。
