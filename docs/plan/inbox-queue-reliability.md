# inbox.jsonl 信頼性改善計画
## 0. 目的と前提
- 対象は Discord 受信、cron、RSS dispatch、agent 実行、Discord 配送である。
- 現在の `data/queue/inbox.jsonl` は、`inFlightIds`、session Promise chain、retry counter、完了 tombstone に正しさを依存している。
- `inbox.jsonl` の実データには、RSS cron の空 `content`、`completedAt`、`idempotencyKey` を持つ完了行がある。
- 目標は受理済み入力を失わず、agent 再実行と Discord 再送を独立して復旧できることである。
- 実行モデルは one-shot とし、1入力につき host-owned job と使い捨て container を基本単位にする。
- queue の正本は host 所有の単一 `runtime.sqlite` とする。
- SQLite 内の `jobs`、`deliveries`、`idempotency_keys` は論理的に分離する。
- session 履歴、group workspace、AGENTS/MEMORY snapshot は既存の外部永続領域を正本として残す。
- RSS feed/article 収集状態は当面 `rss.sqlite3` に残し、dispatch と queue の間は reconciliation で収束させる。
- Discord API の exactly-once は保証されないため、host は at-least-once と `ambiguous` を明示する。
- 本書は設計計画であり、コード変更は含まない。
## 1. 現状と問題
- `src/queue/inbox.ts` は JSONL 全体を読み、更新・削除時に全体を書き直す。
- ファイル内 lock は同一 process の競合を抑えるが、process をまたぐ ownership、lease、fencing を持たない。
- host crash 後は claim 中か未着手か、agent result 済みか、Discord 送信済みかを判定できない。
- `src/queue/poller.ts` は agent 成功後に inbox 行を削除し、その後 Discord へ送るため、送信失敗時の再開経路がない。
- 送信後に成功記録できない場合は、再送すると重複する可能性がある。
- RSS dispatch は記事 claim、inbox 投入、`read_at` 更新が `rss.sqlite3` と JSONL に分かれている。
- RSS の完了 tombstone は冪等性の検索を支えるが、queue payload と retention を不必要に汚染する。
- `rss-dispatch` が既に dispatch id を冪等キーにしているため、その意味論を DB table へ移行する。
## 2. 目標構成

```text
Discord / Cron / RSS
        |
        v
 host admission
        |
        v
 runtime.sqlite
 ├─ jobs
 ├─ deliveries
 ├─ idempotency_keys
 └─ dead_letters / optional events
        |
        +--> one-shot claim / lease
                    |
                    v
           disposable container
                    |
                    v
              agent result
                    |
                    v
             delivery worker
                    |
                    v
                 Discord
```
- `runtime.sqlite` は queue の唯一の正本であり、inbound DB と outbound DB を分けない。
- `jobs` は入力受理と agent 実行だけを表す。
- `deliveries` は canonical result の外部配送だけを表す。
- agent の成功は `jobs.succeeded`、Discord の成功は `deliveries.sent` である。
- result 保存と delivery row 作成は同一 transaction とし、agent と配送を別 worker で処理する。
- 空 response は delivery を作らず、agent 完了だけを確定する。
- tool progress、typing、best-effort error event は初期スコープ外とする。
## 3. データモデルと状態遷移
### 3.1 `jobs`
- `id`、`kind`、`group_name`、`channel_id`、`session_id`、`reply_message_id` を持つ。
- `payload_json` は入力、添付、cron 設定、RSS article id を含む。
- `status` は `accepted`、`queued`、`claimed`、`running`、`result_ready`、`succeeded`、`retry_wait`、`failed`、`dead_letter` とする。
- `attempt`、`max_attempts`、`worker_id`、`lease_until`、`fencing_token` を持つ。
- `result_json` は canonical response、usage、timing、snapshot metadata を保存する。
- `succeeded` は agent result の durable 化を意味し、Discord 送信済みを意味しない。
### 3.2 `deliveries`
- `id`、`job_id`、destination、channel/thread、reply metadata を持つ。
- `response_index`、`payload_json`、`payload_hash`、`external_message_id` を保存する。
- `status` は `pending`、`claimed`、`sending`、`sent`、`ambiguous`、`retry_wait`、`failed` とする。
- `(job_id, destination_type, response_index)` に unique 制約を置く。
- `sent` は agent job を再実行せず、delivery だけを再処理しない。
### 3.3 `idempotency_keys`
- `key` を primary key とし、`job_id`、`kind`、`payload_hash`、`state`、期限、時刻を持つ。
- 同一 key で payload hash が違えば conflict として受理しない。
- RSS dispatch id、Discord admission key、cron key を同一 table で検索する。
- 完了 tombstone の代わりに key の状態を保持し、key と job を同一 transaction で insert する。
- retention は最大 replay window より長くし、期限到来後にのみ pruning する。
### 3.4 状態遷移と不変条件
- job は `accepted -> queued -> claimed -> running -> result_ready -> succeeded` と進む。
- 一時失敗は `claimed/running -> retry_wait -> queued`、恒久失敗は `failed -> dead_letter` とする。
- delivery は `pending -> claimed -> sending -> sent` と進む。
- 一時送信失敗は `retry_wait -> pending`、応答不明は `sending -> ambiguous` とする。
- lease 切れは token を確認して queued/pending へ戻し、古い worker の update は拒否する。
- `ambiguous` は blind retry せず、外部確認後だけ `sent` または `retry_wait` に進める。
## 4. 対象範囲
- 再起動後の未完了 job、未配送 delivery、lease 切れ claim の再発見を対象にする。
- group/session routing、Credential Proxy、Docker 隔離、Pi agent loop は維持する。
- session JSONL、Flue conversation store、group workspace は別 migration とする。
- 外部 tool の副作用は tool-level key を受け取れるようにするが、全 tool の exactly-once は別課題とする。
- 初期は最終 response delivery を durable 化し、進捗イベントは best-effort とする。

# Phase 1: queue storage 置換
## 目的
- JSONL を `runtime.sqlite` の durable queue に置き換える。
- claim、lease、retry、dead-letter、冪等性を process 外へ移す。
- RSS 完了 tombstone を `idempotency_keys` へ移し、inbox から解消する。
## 変更対象
- `src/queue/inbox.ts`、`src/queue/poller.ts`、`src/queue/dead-letter.ts`。
- `src/cron/enqueue.ts`、`src/cron/runner.ts`、`src/discord/handler.ts`。
- `src/cron/jobs/rss-dispatch.ts`、`src/rss/store.ts` と reconciliation。
- queue repository、SQLite migration、unit/integration tests。
- `data/queue/inbox.jsonl`、`dead-letter.jsonl`、既存 `data/rss.sqlite3`。
## 実装項目
- runtime DB を固定パスに作成し、WAL、foreign keys、busy timeout、schema version を設定する。
- jobs、deliveries、idempotency_keys、dead_letters と必要な検索 index を作る。
- enqueue は key 検索と job insert を一 transaction で行う。
- claim は `BEGIN IMMEDIATE`、lease、worker id、fencing token を一体化する。
- retry は attempt、next_attempt_at、last_error を DB 更新で確定する。
- dead-letter は DB row とし、必要時だけ JSONL export する。
- `inFlightIds` は性能上の重複 dispatch 抑制に限定し、正しさの根拠にしない。
- RSS dispatch id と job id を対応付け、孤立 claim を検出・release する。
- 対応 job が成功した RSS claim は read 済みに収束させる。
- 2 DB の間で crash しても起動時 reconciliation で収束する。
## データ移行
- inbox、dead-letter、runtime DB、RSS DB を先に byte 単位で backup する。
- 正常な未完了 inbox 行は jobs の queued または retry_wait に移す。
- `completedAt` 行は agent 再実行せず、idempotency_keys の completed として登録する。
- 完了 tombstone の空 payload は移さず、監査 metadata だけ残す。
- malformed 行は既存 dead-letter と照合し、replay せず監査 row にする。
- RSS `dispatch_job_id` を既存 key/job に紐付け、対応なしの claim は release する。
- 移行中は旧 writer を止め、旧 JSONL は read-only archive として保持する。
## 完了条件
- Discord、cron、RSS の新規入力が JSONL ではなく runtime.sqlite に入る。
- 再起動後に queued、retry_wait、lease 切れ job を再取得できる。
- 同一 key の enqueue が一件の job に収束する。
- 完了済み RSS 入力が空 tombstone として再生成されない。
- malformed 行、dead-letter、orphan RSS claim の移行件数を説明できる。
- queue 操作が process memory なしで transaction と token により成立する。
## テスト観点
- 同時 enqueue、同時 claim、lease 切れ再取得を検証する。
- 古い fencing token の update が拒否されることを検証する。
- retry backoff と max attempts が再起動後も保持されることを検証する。
- malformed 行を job にせず dead-letter へ収束させることを検証する。
- RSS claim、queue insert、host crash の全順序で同じ最終状態になることを検証する。
- cron direct/new-thread、Discord message の payload 互換性を検証する。
## ロールバック
- 新 writer を停止し、runtime DB と migration 前 JSONL の backup を保持する。
- agent 実行前 job だけを JSONL に再生成し、実行済み job は再投入しない。
- completed key の情報を使い、必要最小限の tombstone だけを復元する。
- RSS DB を backup から戻す場合は orphan claim を再検査する。
- rollback 中は producer を一つに固定し、SQLite/JSONL の二重書きを禁止する。
## 依存関係
- SQLite driver、migration 方式、backup/restore 手順を先に決める。
- Phase 2 の claim/lease API と result repository の前提になる。
- Phase 3 の delivery transaction のために job id と payload format を固定する。
- RSS DB を残す cross-DB reconciliation の責任者と実行タイミングを決める。

# Phase 2: agent 状態永続化
## 目的
- agent の実進行を job 状態へ反映し、crash、timeout、container failure を復旧する。
- session Promise chain を durability の正本から外し、DB claim/lease へ寄せる。
- agent 完了を Discord 配送完了から独立して確定する。
## 変更対象
- `src/queue/poller.ts` の `processMessage`、session chain、retry 処理。
- agent manager、sandbox runner、使い捨て Docker の timeout/exit 連携。
- provider concurrency lock と DB claim の境界。
- session/Flue snapshot の受け渡しと jobs の result metadata。
- poller、sandbox、failure recovery の tests。
## 実装項目
- claim 後に claimed、container 起動後に running を保存する。
- 長い agent は lease heartbeat を行い、古い container の更新を fencing で拒否する。
- exit code、termination、stop reason、usage、timing、attempt を保存する。
- result が durable でない失敗だけを agent retry の対象にする。
- canonical response を result_json に保存し、job succeeded を同じ transaction で確定する。
- result 保存と delivery row 作成を同一 transaction にする。
- 空応答、non-retryable、max retry 到達を個別の terminal state にする。
- session 順序は session_id と sequence または DB 条件で保証する。
- provider lock は負荷制御として残してよいが、正しさを memory に置かない。
- AGENTS/MEMORY snapshot の hash を保存し、retry 時の入力条件を固定する。
- agent 完了後は container を破棄し、workspace/conversation 外部状態だけを残す。
## データ移行
- Phase 1 の旧 retries を attempt に反映する。
- 実行中と判定できない旧行は安全側に queued とする。
- 旧 Promise chain は復元せず、session_id の制約を DB から再構成する。
- session JSONL は移動せず、path と snapshot hash のみ job metadata に持つ。
- 旧 dead-letter は履歴として取り込み、再実行対象にしない。
## 完了条件
- host 再起動後に running 相当 job が lease 判定で回復する。
- result 済み job は agent を再実行せず後続処理へ進む。
- result 保存前 crash は再試行可能になり、保存後 crash は再実行されない。
- session の直列性と異なる session の並列性が再起動後も成立する。
- container が消えても result、attempt、error、snapshot を追跡できる。
- jobs.succeeded が Discord 送信成否を参照しない。
## テスト観点
- claim 直後、container 起動直後、loop 中、result 生成直後の crash injection を行う。
- heartbeat 停止、lease timeout、fencing 競合を検証する。
- exit code、timeout、signal、non-retryable の遷移を検証する。
- session 順序、provider 並列性、result commit 前後の再起動を検証する。
- AGENTS/MEMORY snapshot と tool call key が retry で変わらないことを検証する。
## ロールバック
- 未実行 job だけ旧 poller adapter へ切り替える。
- result_json がある succeeded job は再実行せず監査対象にする。
- lease、retry、idempotency key を失う DB rollback は行わない。
- rollback 中も新規 key を保持し、二重受理を防ぐ。
## 依存関係
- Phase 1 の jobs schema、claim、lease、idempotency_keys が必須である。
- container runner が exit status、timeout、termination を返す必要がある。
- Phase 3 の delivery row を作る canonical result format を固定する。
- session store と workspace mount の既存契約を維持する。

# Phase 3: delivery 分離
## 目的
- agent 完了と Discord 配送完了を別状態機械として運用する。
- Discord 失敗時は保存済み result だけを再送し、agent を再実行しない。
- 分割 response、reply、cron thread、external message id を durable にする。
- 送信後の通信断を ambiguous として可視化する。
## 変更対象
- `src/queue/poller.ts` の agent 後 Discord 送信処理。
- `src/discord/handler.ts` の channel/thread metadata。
- cron direct/new-thread と `cronThreadId` の保存経路。
- runtime.sqlite deliveries、delivery worker、retry loop。
- delivery unit/integration/crash recovery tests。
## 実装項目
- result commit 時に final response を delivery row へ分割登録する。
- `response_index` で chunk 順序を保持し、先行成功後に次へ進む。
- reply、channel、thread、cron metadata を payload に固定する。
- delivery worker は pending のみ claim し、agent job は参照だけにする。
- API 前に sending/lease、成功後に external id/payload hash/sent を保存する。
- API error を retryable/non-retryable に分類する。
- timeout で結果不明なら ambiguous とし、blind retry を止める。
- channel history、payload hash、operator 判断で ambiguous を解決する。
- thread 作成後の thread id を保存し、retry で再作成しない。
- delivery failure を agent failure/dead-letter と同じ state に混ぜない。
- tool_start、typing、best-effort event は final delivery から分離する。
- Discord API に idempotency key がないため、host unique key と照合手順を残す。
## データ移行
- result_json がある job から delivery payload を再構成する。
- 旧ログから送信未確定を復元できる場合だけ delivery にする。
- 既存 cronThreadId は destination metadata に移す。
- completedAt tombstone を Discord sent の証拠とはみなさない。
- 状態不明の旧送信は自動 ambiguous にせず、未復元監査項目として分離する。
## 完了条件
- agent 成功後に Discord が停止しても delivery worker が再開できる。
- delivery retry で sendMessage、container、LLM が再実行されない。
- direct、reply、分割、new-thread が再起動後も維持される。
- send 後 commit 前 crash が ambiguous として検出できる。
- jobs.succeeded と deliveries.sent を別集計できる。
- sent delivery が unique/state check で再処理されない。
## テスト観点
- result commit と worker 起動の間、send 前、send 後 commit 前の crash を検証する。
- chunk 順序、部分送信、channel fetch、permission、rate limit、timeout を検証する。
- thread 作成後の再起動で再作成しないことを検証する。
- ambiguous を自動 retry せず、operator 解決後に一度だけ進むことを検証する。
- agent succeeded で delivery だけ retry されることを検証する。
## ロールバック
- delivery worker を停止し、未送信 pending だけ旧送信経路へ手動切替する。
- succeeded result は保持し、agent 再実行の rollback は行わない。
- sent/ambiguous を pending に戻さず、外部二重送信を避ける。
- delivery export を保存し、旧システムへは operator 承認で移す。
## 依存関係
- Phase 2 の canonical result、succeeded、attempt metadata が必須である。
- Discord adapter が channel/thread metadata を安定取得できる必要がある。
- external id、payload hash、ambiguous の運用手順を先に用意する。

# Phase 4: retention と観測
## 目的
- 履歴を無制限に持たず、冪等性と監査性を両立する。
- crash recovery、RSS tombstone、ambiguous delivery を運用で発見する。
- DB、WAL、backup、pruning を安全に管理し、改善を数値化する。
## 変更対象
- runtime.sqlite の retention、archive/export、index。
- queue、delivery、RSS reconciliation の structured logging。
- metrics、health check、operator inspection、backup 手順。
- 旧 JSONL archive と migration/retention/observability tests。
## 実装項目
- jobs は terminal 化後に archive、deliveries は sent/failed/ambiguous 別に保持する。
- idempotency_keys は最大 replay window より長く保持する。
- RSS key は再取得周期と manual replay 期間を考慮して pruning する。
- pruning 前に payload hash と最終状態を export する。
- queue depth、oldest age、lease expired、agent success、delivery sent を分離観測する。
- delivery ambiguous/retry、dead-letter、RSS orphan/tombstone migration を記録する。
- poll、agent、delivery latency の分位点を記録する。
- integrity check、WAL checkpoint、backup 成功時刻を health check に含める。
- stale claim と ambiguous は alert 対象にする。
- retention は小分け transaction と dry-run を持つ。
## データ移行
- 旧 dead-letter と inbox backup を日付付き archive へ登録し、原本は削除しない。
- Phase 1 の tombstone 件数と idempotency_keys 件数を突合する。
- RSS `read_at`、dispatch marker、対応 job を定期突合する。
- retention 前に duplicate key、orphan job、orphan delivery の baseline を作る。
## 完了条件
- active の queued/running/pending/ambiguous が retention で削除されない。
- key の期限前に同一入力が二重受理されない。
- queue/delivery の SLA 指標を日次確認できる。
- RSS tombstone 再発時に件数と対応 job を特定できる。
- backup restore と SQLite integrity check を定期実行できる。
## テスト観点
- terminal、active、ambiguous の retention 境界を検証する。
- clock skew、期限境界、replay window 内外を検証する。
- RSS orphan の検出、release、read_at 収束を検証する。
- WAL backup restore、大量 archive、metrics の agent/delivery 分離を検証する。
## ロールバック
- 削除前 export を作り、archive から復元できるようにする。
- metrics/alert は queue state を変えず単独停止可能にする。
- pruning は feature flag で無効化し、archive 失敗時は削除を commit しない。
## 依存関係
- Phase 1〜3 の state と audit metadata が確定している必要がある。
- retention 期間を RSS replay、Discord ambiguous 解決、backup 運用と合意する。
- backup、alert、operator 権限を本番へ組み込む。
## 5. 採用しない案
### NanoClaw の inbound DB と outbound DB
- 現行は one-shot であり、host が入力、実行対象、result、retry をすでに把握している。
- container inbound DB を足すと同じ入力が host と container に二重化し、正本が曖昧になる。
- host running/container 未読、container 完了/host running、retry の二重投入を復旧する必要がある。
- outbound DB も host delivery outbox と重なり、agent result と送信状態の正本が二つになる。
- 必要なのは物理 DB 分離ではなく、同一 SQLite 内の jobs/deliveries の論理分離である。
- background agent、複数非同期 outbound、pause/resume、長時間 connection が必要になった時だけ再評価する。
### NanoClaw の長寿命 container
- 現行は短時間の agent turn と final response で、process-local state の再利用が必須ではない。
- prompt injection、常駐 process、modified file、memory leak が次の入力へ持ち越される。
- group/session/thread の共有単位、health check、restart、idle timeout、zombie cleanup が必要になる。
- host DB と container 内 state が二重正本になり、container alive と agent process alive の不一致が増える。
- Disposable container は既知状態、credential-free、実行後破棄を維持できる。
- workspace、conversation、Credential Proxy を外部に置けば永続性と隔離を両立できる。
### JSONL 延命、jobs/deliveries 別 DB
- lock 強化だけでは lease、fencing、transaction、複数 process の復旧を自然に表現できない。
- jobs と deliveries を別 SQLite にすると、result と delivery row の atomic commit が難しくなる。
- 単一 SQLite の transaction 境界が one-shot queue には最も単純である。
## 6. 実施順序と判断ゲート
- Phase 1 前に inbox、tombstone、RSS orphan の baseline と backup を保存する。
- Phase 1 は shadow read、migration report、reconciliation の確認後に cutover する。
- Phase 2 は crash injection で result durability を確認してから有効化する。
- Phase 3 は test channel で chunk retry、thread 再利用、ambiguous を確認する。
- Phase 4 は dry-run で active row を除外できることを確認してから pruning する。
- 各 gate で queue depth、duplicate key、agent retry、delivery retry、RSS orphan を比較する。
- gate 未達なら次 Phase に進まず、当該 Phase の rollback 条件を適用する。
- 最終判定は agent が一度成功したことではなく、job と delivery の状態が再起動後に説明可能であることである。
