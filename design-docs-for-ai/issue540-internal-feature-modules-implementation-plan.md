# Issue #540 実装計画：Host内の機能別責務と薄い登録契約

## 入力・境界

対象は https://github.com/shin902/my-discord-agent/issues/540 。`gh issue view 540 -R shin902/my-discord-agent --json title,body,comments` で本文全体を取得して確認済み（コメント0件）。この計画は2026-09時点のcheckout `49fe51fb` のコードに基づく。実装開始時に差分があれば、変更された箇所の現行コードとIssueを照合する。Issueの背景に出てくるPR #539のMail routing／継続threadは、現在の `src/cron/jobs/mail.ts` には実装されていない。**それを新たに実装しない**。このIssueで決まったのは構造の移行であり、Mail・RSS・Screen Capture・外部Memory exportの下記の現行動作を保つこと。既存の設定ファイルの場所・形式・値の意味、Discord ready／backfill開始順、session ID、DB配置を変えない。

完成の判定：共通queue/poller/deliveryがMail/RSS/Memory固有の完了判断やIDの意味を持たず、機能側が既存の永続状態を通じて同じ結果を出す。新しく共通化するのは実在する複数経路の接点だけ。全機能を単一の汎用plugin frameworkへ押し込まない。新機能用の自動loader、OpenClawへの移行、別channel/executor、bootstrap/contextFilesのhook化、全cron jobの改造、Mail ACK専用queue、新しいretry契約は対象外。ここに挙げたファイル・関数・columnは現存、**「新規」**を付けたものだけ新しく作る。

## 現状の正本と、維持する動作

- `src/index.ts` はqueue初期化→RSS reconciliation→Discord login→backfill→startup job→poller/delivery/cronを起動する。`src/cron/runner.ts` は設定を起動時に読み、readyなDiscord clientがないtickを見送る。receiverは別に起動する。起動条件は変更しない。
- `src/queue/types.ts` の `InboxMessage` がMail/RSSのID、Memory用 `jobKind` を含む。`src/cron/enqueue.ts` がMail/RSS IDをqueueへコピー、`src/queue/repository.ts` の `jobs.payload_json` と `deliveries.payload_json` が永続化する。`QueueRepository.enqueue()` はMailのterminal後だけactive-only dedupeに切り替え、`claimDelivery()` のSQLはRSSの失敗chunk特例を持つ。後者も単なる呼び出し元の移動では取り除けない。
- `src/queue/poller.ts` は `processMessage()` のMemory export分岐、RSS失敗・無配信確定、Mail無配信ACK、配送payloadへのMail/RSS ID注入を持つ。`src/queue/delivery.ts` の `DeliveryWorker.process()` はchunk送信結果を更新し、Mailは全chunk `sent` 後にACK、RSSはsettle／releaseする。`src/queue/reconciliation.ts` は起動時にRSS claimとqueue結果を照合する（移動後の旧importも更新する）。配送結果の `ambiguous` は送信成功を意味しない。`QueueRepository.commitResult()` がAgent結果・delivery intent・採用会話参照をfenced transactionで確定することを維持する。
- MailはGraph未読を次回cronで取得し直す。失敗したAgentにACK-only retryは作らない。既読化失敗時は未読が残りterminal job後のDiscord投稿重複があり得る。`<NO_REPLY>` 成功では配送なしでACKする。RSSはclaim→投入→配送全chunk成功か明示的抑制で既読、失敗時は解放、起動時に再照合。`Screen Capture` はfull batchのみ要約、成功後 `completed_at` を付け、GCは完了後24時間超のみ削除。Memory exportは `committed_conversations` とgroup `sessions.sqlite` を読み、remote受理後に `memory-export.sqlite` にmarkerを記録し、無効なcron IDの待機jobはno-op。remote受理とmarker記録間で落ちたときの重複は許容する。
- 保存先は `docs/storage.md` に従う：`data/runtime.sqlite` のjob/delivery/idempotency、`data/rss.sqlite3`、`data/screen-captures.sqlite`、`data/memory-export.sqlite`、group別 `sessions.sqlite`。別DBと外部APIを跨ぐatomic commit／exactly-onceは作らない。Mail専用DBは新設しない。

## 実装順と設計

### 1. 共有する境界を小さく定義する

**新規 `src/queue/job-handlers.ts`**：明示登録された内部job種別と、source-specific lifecycle callbackの小さなregistryを設ける。登録時に安定したIDの重複を拒否する。汎用service locatorにせず、実装に必要な `QueueRepository` の公開メソッドと機能固有の依存だけを登録時に与える。永続入力は `kind` と機能所有のJSON入力を持ち、復元時に登録された機能がZod等で検証する（未登録のkindを成功として捨てず、対象jobを診断可能なまま保持する）。callback対象は①配送を抑制した成功、②fencedなjobのterminal transition、③配送chunkのfencedな状態更新と当該jobの全chunk状態、の実際に使う境界だけ。配送済み通知を唯一の正本にしない：必要なら既存のjob／delivery正本から再照合する。callbackは失敗しても既に確定したAgent結果やdeliveryを巻き戻さず、現行のMail未読／RSS claimから復旧する。MailのACK失敗は記録して返し、次回cronの未読再取得に委ねる。RSSのsettlement失敗は既存の起動時reconciliationで参照可能にする。callbackでqueue lease・retryを独自実装しない。

**注意：** MailとRSSではterminal jobと外部ACKは同義ではない。source contextを `InboxMessage` とdelivery payloadで永続化し、共通側ではopaqueとして運ぶ。RSS dispatch job keyはsource inputに保持して照合し、GraphメールIDもsource inputに保持する。共通deliveryはメールIDを直接読まない。`DeliveryWorker` が成功chunkの送信結果をfencedで保存した**後**にsource callbackを呼ぶ。失敗chunkに対するRSS固有のbatch terminal遷移は現行 `failDeliveryBatch()` と `claimDelivery()` の前後関係を保ちつつ機能別policyとして登録する。generic callbackの実装だけで既存SQLのRSS特例を見落とさないこと。共通SQLが機能の識別子を解析しないよう、必要なら永続job／deliveryの機能種別を独立した共通discriminatorとして格納し、SQL側は登録済みpolicyの識別と状態だけを使う。必要なcolumn・indexと旧行の変換は変換スクリプトで行い、稼働中の旧形式自動migrationにはしない。

**新規 `src/features/mail.ts`、`src/features/rss.ts`、`src/features/memory-export.ts`**：既存handlerやstoreを再実装せず、source入力の検証、既存 `acknowledgeEmail()`、`settleRssDispatch()`、`reconcileRssDispatches()`、`runMemoryExport()` を使う登録箇所を所有する。RSSのreconciliation本体も `src/queue/reconciliation.ts` からRSS側へ移し、起動時の明示呼出しは新しいRSS公開入口経由にする。旧ファイルは既存テストやimportを新しい公開入口へ移行した後で削除し、二つのreconciliation正本を残さない。Memoryは起動時cacheのcron IDと `isCronHandler()` の既存同一性判定を維持する。`src/features/screen-capture.ts`（新規）はreceiver/summary/GCの起動・依存の組み立てだけを担当し、既存DBとhandlerの処理は必要がなければ動かさない。`src/cron/jobs/screen-capture-summary.ts` と `src/cron/jobs/screen-capture-gc.ts` は現行handlerの公開入口のまま利用し、変更不要なら編集しない。受付済みの通常jobはcron無効化後も処理し、Memory exportのno-opだけは例外。

### 2. 現行producer／queue／配送から固有知識を移す

- producerは `src/cron/jobs/mail.ts` と `src/cron/jobs/rss-dispatch.ts`、内部job producerは `src/cron/jobs/memory-export.ts`。設定・prompt・dedupe key・session identityはそのまま、固有入力を機能側で作る。`src/cron/enqueue.ts` はcron共通のAgent入力とdelivery/session modeのみを組み立て、mail/rss固有プロパティを削除する。Mail/RSSのhandlerは機能側の薄いenqueue入口を使用する。その他の既存cron handlerの `enqueueCronInbox()` 呼び出しは保ち、共通のprompt/モデル検証を二重実装しない。
- `src/queue/types.ts`：既存の共通channel/session/Agent要件は通常Agent jobに残す。新たなhost-only仕事には型付き入口を設け、Memoryを意味のない空文字のchannel/group/contentで表現するproducerコードをなくす。既存のqueueのsession ordering用IDは維持し、必要なら保存時の互換用defaultはrepository内部に閉じる。共通の永続envelopeは小さくし、source入力は機能側で検証する。通常のDiscord intake／Bot／cronの既存payloadとvalidation、`normalizeInboxMessagePayload()` の過去snapshot互換は不要に壊さない。
- `src/queue/repository.ts`：`enqueue()` の `mailEmailId` 依存を永続payload内の登録済みsource policy（受付時に妥当性確認）によるactive-only idempotency判定に変更する（Graph未読を理由にterminal keyが再利用可能なのはMailのみ）。`claimDelivery()` のRSS前chunk失敗特例も登録したsource policyで表現し、配送順序・retryとlease/fencingを変えない。ただしSQL claim時点でプロセス内callbackは使えないので、job行へ永続化した機能種別・配送policyを参照し、SQLはそれらの汎用状態だけで条件を組み立てる（旧 `json_extract(...,'$.rssDispatchId')` の移行が必要）。`listRssStatePaths()` はRSS側の再照合で利用する共通の保存済みsource path列挙APIへ変更し、他sourceの機密入力を走査結果へ漏らさない。`commitResult()` の既存transactionは維持する。スキーマ変更する場合はversioned schemaを新バージョンにし、旧形式の本番移行は後述の一回限りのスクリプトで行う。
- `src/queue/poller.ts`：Memory exportを登録されたhost-only runnerから呼び、Agent/Discord/provider lockを経由しない。pollerのclaim段階でMemoryを通常Discord-ready jobの判定に巻き込まない現行動作を維持する。`finalizeSuppressedSource()`、`settleRssDispatchAfterQueueTransition()`、失敗release経路、通常／thread両経路のdelivery payload構築を登録契約経由にする。通常の `freezeExecutionIdentity()`、空応答 `dead_letter`、`<NO_REPLY>`、Agentの `failAttempt()`、item-thread昇格を変えない。
- `src/queue/delivery.ts`：`DeliveryWorker.process()` のMail ACK・RSS settle・失敗batch policyを登録済みsourceへ委譲する。`startDeliveryWorker()` とテストで直接newする `DeliveryWorker` の両方へ同じ登録済み契約を渡し、未登録の配送だけを通常の共通処理へ通す。`DiscordDeliveryAdapter`、`DeliveryAdapter.send()`、`DeliveryWorker.runOnce()`、送信成功後の `updateDelivery()` と失敗時の `failed`／`retry_wait`／`ambiguous` は維持する。MailのACK失敗は配送の送信失敗へ変換せず未読を残す。RSSの失敗はclaimを解放するが、成否不明な送信を成功扱いしない。送信済みchunkがある状態で失敗した際の現行の残りchunk処理をテストで固定する。
- `src/index.ts`：Mail/RSS/Memory/Screen Captureを明示登録し、依存を必要なものだけ渡す。登録済み契約をpoller／deliveryに同一インスタンスとして渡す。既存のテストが `processMessage()` や `DeliveryWorker` を直接呼ぶ入口には、テストで明示的に登録して渡せる構築方法を設け、グローバルの登録順に依存させない。設定・DB初期化、RSS起動時reconciliation、receiver開始、Discord login→backfill→poller/delivery/cronの順序とshutdown順序は維持する。`src/cron/runner.ts` の設定cache・ready判定・handler loaderは維持。設定ファイル・exampleの移設はしない。

### 3. 旧データを変換する（本番の自動migrationではない）

**新規 `scripts/convert-issue540-runtime.ts`**：明示的に一回実行する変換スクリプト。現在の `jobs.payload_json`、`deliveries.payload_json`、`dead_letters.payload_json`（存在する場合）についてMail/RSS/Memory識別情報を新source envelope／host-only識別へ変換する。必要な新しい識別columnがあれば既存queueとdeliveryの参照関係、`idempotency_keys`、`jobs.session_id`、fencing/status/attempt、`committed_conversations` を維持する。Mailのactive-only terminal key、RSSのdispatch ID／statePath／dispatch job key、Memoryのcron IDを失わない。RSSのclaimを持つ別DB・Screen Capture・group session DB・Memory ledgerの**内容**を削除しない。変換スクリプトを実行した後の形式だけ新runtimeが読む。旧形式読み取り互換、起動時の自動移行、旧jobの手作業点検、専用エラー画面、スクリプト再実行対応は作らない。SQLiteの短いtransactionで変換し、LLM/HTTPをtransaction中に呼ばない。元形式のファイルコピー保持は要件ではない。実装計画に従う運用では旧workerと新workerを同一queueで並走させない。

### 4. テストと文書

| 既存／新規ファイル | 変更・検証内容 |
| --- | --- |
| `src/queue/repository.test.ts`、`src/queue/runtime-schema.test.ts` | Mailだけterminal後の未読再投入、通常sourceのdedupe、schema変換後のjob／delivery claim、RSS前chunk失敗特例と他sourceの独立性 |
| `src/queue/poller.test.ts`、`src/queue/poller.item-thread.integration.test.ts`、`src/queue/memory-export.integration.test.ts` | 通常／thread／NO_REPLY／空応答／Memory host-only、Agent失敗時の正本と結果commit。runner無しのfakeで検証 |
| `src/queue/delivery.test.ts`、`src/queue/delivery.item-thread.test.ts`、`src/queue/rss-batch.test.ts`、`src/queue/reconciliation.test.ts` | fake `DeliveryAdapter` で全chunk `sent` のみMail ACK、ACK失敗は未読、RSS sent/suppressed/failed/ambiguousと起動時再照合、thread/session昇格 |
| `src/cron/jobs/mail.test.ts`、`src/cron/jobs/rss-pipeline.test.ts`、`src/cron/jobs/screen-capture-summary.test.ts`、`src/cron/jobs/screen-capture-gc.test.ts` | 現行producer／full batch／成功後 `completed_at`／24h GCの回帰 |
| `src/memory/export.test.ts`、`src/cron/runner.integration.test.ts` | 成功marker、失敗retry、disabled no-op、設定再起動反映、cron開始条件とbackfill後起動順 |
| **新規** `src/queue/job-handlers.test.ts`、`scripts/convert-issue540-runtime.test.ts` | 明示登録の重複・不明kind拒否、実SQLiteの旧形式→新形式変換と未完了job／配送payload／採用会話参照の維持。移行後に後続jobが動くことまで検証 |
| `docs/inbox-queue.md`、`docs/storage.md`、`docs/spec/cron.md`、`docs/agent-memory.md`、`docs/config.md` | 実際に変わった内部接続・一回限り変換の運用だけ更新。RSSの旧「queue投入で既読」記述は現在の配送後settlementと整合させる。設定例の場所／形式は変更しない |

上表の「新規」以外のテストパスはcheckout内で存在を確認した。テストではGraph／Discord／backendの実接続をしない最小fakeを使い、実SQLite（temp path）でlease・fencing・transaction／復旧を確かめる。実外部APIのexactly-onceや外部side effectの取り消しをfakeで保証したことにはしない。source callbackの失敗位置（commit直後、最終chunk直後、ACK前、remote受理後marker前）を個別に検証する。既存テスト内で差し替えるより小さいテストを優先し、不要な大量のテスト雛形は増やさない。

## ライブラリAPIと一次情報（このcheckoutにインストール済み）

新依存は追加しない。`pnpm list --depth 0` で以下を確認。コード中の既存呼び出しを優先し、これらのAPIを使う場合だけ公式資料と照合する。

- `better-sqlite3@12.11.1`：`db.prepare(sql).all()`／`.get()`／`.run()`、`db.transaction(() => { ... })()` を使用し、同期transaction内部で `await` やHTTPを実行しない。https://github.com/WiseLibs/better-sqlite3/blob/v12.11.1/docs/api.md （installed版の型は `node_modules/@types/better-sqlite3/index.d.ts` で確認）。JSONの変換はSQLiteのJSON演算だけに依存せずTS側でも内容を検証する。
- `zod@4.4.3`：既存の `z.object({...}).safeParse(value)` の `success` と `data`／`error` を使ってsource固有JSONを検証。https://zod.dev/basics
- `vitest@4.1.5`：既存の `describe`／`it`／`expect`、必要な箇所だけ `vi.fn()`／`vi.mock()` を使う。テストを `*.test.ts` に置き `pnpm test` で実行。https://vitest.dev/guide/ と https://vitest.dev/guide/mocking.html
- `discord.js@14.26.4`：新しいDiscord SDK APIは不要。既存 `DiscordDeliveryAdapter` の `send()` を維持し `DeliveryWorker` にfake `DeliveryAdapter` を渡す。Discord実接続による確認では既存clientの `login()`／`isReady()` を使用。https://discord.js.org/docs/packages/discord.js/14.26.4/Client:Class
- `@biomejs/biome@2.4.15`：変更したBiome対象ファイルごとに `pnpm exec biome check --write <path>`。https://biomejs.dev/guides/getting-started/ とリポジトリの `AGENTS.md`。

## 品質管理とブラウザ確認

ルート `CLAUDE.md` には独立した「品質管理の実行手順」節は**存在しない**。同ファイルは `AGENTS.md` に委譲している。各Biome対象ファイルの編集直後に `pnpm exec biome check --write <changed-file>`、最終的に `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test` を実行し失敗を修正する。`pnpm build` とqueue／delivery／RSS／Memory／Screen Captureの対象テストも実行する。変更後は `git diff` と現行ドキュメントの記述を照合し、適切な単位でcommitする。実行環境はNode.js 22+／pnpm。計画作成時の未変更コードで `format:check`／`lint`／`typecheck` は通過、`pnpm test` は4ファイル22件が環境依存で失敗した（Docker daemon未起動の `src/index.test.ts`、macOSの `/proc/self/fd` 不在による `src/tools/bash.test.ts`、`/var` と `/private/var` のpath差による `.pi/extensions/biome-after-write/index.test.ts` と `src/integrations/x-saved/store.test.ts`）。実装後もこれらを新規回帰と混同せず、対象テストの成否とCI環境の結果を区別する。運用DBをad-hoc SQLで書き換えない。実データ検査が必要なら `.pi/skills/runtime-db/SKILL.md` のread-only手順に従う。

ブラウザで確認する対象は専用WebアプリではなくDiscord Web UI。実際の認証済み**テスト用**Discord guild/channelとテスト用Graphメール／RSS feed／Memory backendを使用し、本番データを使わない。`pwd` と `git rev-parse --show-toplevel` で現worktreeを確認、ブラウザで見るBotが配信しているプロセスの起動コマンド／cwd／commitを確認する。別worktreeのサーバーが起動している場合はその観測を流用せず、現worktreeの設定・認証で安全に起動できる隔離環境を準備する（既存本番Botを二重起動しない）。`pnpm build` 後に現worktreeで `pnpm start`、起動ログでDB初期化→RSS reconciliation→Discord login/backfill→workers開始を確認する。ブラウザで `https://discord.com/channels/<test-guild-id>/<test-channel-id>` を開き、テスト用Mailを未読で投入してcronが作った投稿を確認する：全chunk送信後だけGraph側が既読、`<NO_REPLY>` は投稿せず既読。テストRSS記事も同channelに投稿されるまで未読、送信後に既読。既存thread mode使用時は投稿／返信が同じthreadの既存sessionへ対応することを確認する。Graph／RSSの既読状態はそれぞれの管理画面または既存read-only DB手順で確認する。Screen CaptureのDB GCとMemory ledgerはDiscord画面だけでは確認不能なので該当テストとread-only状態確認を併用する。認証・ポート・権限がない場合はUI検証を**未実施**と記録し、fakeテストの成功をブラウザ検証済みと報告しない。Figma対象のUIはない。

## 完了前の照合

- 各機能の現行仕様の維持を上記テストで確認し、旧・新両形式のqueue workerが同時に走らないことを運用手順に残す。
- 新規ファイルは全て「新規」と明記した。既存関数・DB columnはコードで突合し、変更時は命名規則とコメント規則（`code-naming`、`code-comments`）を使う。計画にしか残らない重要な判断理由は実装のcommit／PR本文へ移す。
- 他cron job、file memory／bootstrap、config移設、汎用hook、Redis等の新基盤は追加しない。実装中に現行コードとIssueの意図が重大に矛盾したら推測で仕様を変更せず所有者へ確認する。
