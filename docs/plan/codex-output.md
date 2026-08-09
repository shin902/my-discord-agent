## 結論

**`inbox.jsonl`というファイル形式を維持したまま補修する案は採用しません。**

推奨方針は、NanoClawの長寿命コンテナやinbound/outboundの2DB構成ではなく、文書1・2の結論に沿って、次の構成にすることです。

> **host-ownedの単一SQLite DBに、`jobs`・`deliveries`・冪等キーを持たせる。**  
> agent実行とDiscord送信を別の状態として永続化し、`inbox.jsonl`はactive queueとしては廃止する。

これは「inbox subsystemの置き換え」であり、agent本体、Pi、コンテナ方式、セッション形式には触れません。

RSSの蓄積問題は、RSS側から`idempotencyKey`を外すのではなく、**冪等キーとメッセージ本文を分離する**ことで解決します。RSS producerは原則変更不要です。

---

# 1. 文書1・2から採用する判断

## 採用するもの

`01-nanoclaw-evaluation.md`と`01-nanoclaw-evaluation(1).md`から、次を採用します。

- queueの状態をプロセスメモリではなくhost側の永続ストアに置く
- `claim`
- `lease`
- `retry`
- `crash recovery`
- `idempotency`
- agent実行完了とdelivery完了を分離する
- channel adapterとagent runtimeの責務を分離する
- one-shot agentではhost-ownedな`jobs` / `deliveries`モデルを使う

特に今回の問題は、JSONLという形式そのものより、以下が永続的な状態機械になっていないことです。

- 何が待機中か
- 誰が処理中か
- agentが完了したか
- Discord送信が完了したか
- どの段階で失敗したか
- 再起動後にどこから再開するか

## 採用しないもの

NanoClaw v2の以下は採用しません。

- コンテナごとのinbound/outbound DB
- 長寿命コンテナ
- container側poll
- 双方向mailbox
- 実行中agentへの追加メッセージ
- background agent前提のpause/resume

現在は基本的に、

```text
1件投入
  → agentを1回実行
  → 結果をDiscordへ送信
  → 終了
```

というone-shot構造です。

したがって、NanoClaw型の2DBはYAGNIであり、今回の問題に対して過剰です。

---

# 2. `inbox.jsonl`関連だけで改善できる範囲

「関連だけ」の定義によって結果が変わります。

| 変更範囲                 | 改善できること                                              | 改善できないこと                                    |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------- |
| `src/queue/inbox.ts`だけ | RSS tombstone削減、基本的なstatus/errorフィールド追加       | agent完了判定、Discord送信完了、正しいretry         |
| `inbox.ts`と`poller.ts`  | agent実行状態、エラー、lease、再起動復旧                    | Discord送信後の曖昧性、RSS DBとのend-to-end整合性   |
| queue subsystem全体      | jobs/deliveries、agent完了、delivery retry、RSS本文蓄積防止 | 外部API送信直後のクラッシュによる完全なexactly-once |
| RSS storeまで含む        | 記事単位の最終ackも可能                                     | 変更範囲がRSS subsystemまで広がる                   |

## `inbox.ts`だけでは不足する理由

現在、agent実行とエラー処理はpoller側にあります。

- `/home/shi/ghq/github.com/shin902/my-discord-agent/src/queue/poller.ts:511`
- `/home/shi/ghq/github.com/shin902/my-discord-agent/src/queue/poller.ts:541`

`inbox.ts`は、pollerから通知されない限り以下を知ることができません。

- agentを起動した
- agentが正常終了した
- agentが例外終了した
- timeoutした
- Discord送信に成功した
- Discord送信に失敗した

したがって、**文字どおり`inbox.ts`だけを変更する案では、今回の中心問題は解決できません。**

最低限、`poller.ts`までを「inbox関連処理」に含める必要があります。

---

# 3. 推奨する最小境界

## 対象に含める

```text
src/queue/inbox.ts
src/queue/poller.ts
src/queue/dead-letter.ts
src/cron/enqueue.ts
新規のqueue SQLite store
起動時マイグレーション
関連テスト
```

## 原則として対象外

```text
agent runtime内部
Piのセッション形式
Docker/container実行方式
RSS feed取得処理
RSS解析処理
Discord handler
コンテナの寿命
```

RSSについては、**inboxへの投入APIを維持できるため、蓄積解消だけなら`rss-dispatch.ts`や`rss/store.ts`を変更する必要はありません。**

既存の次の処理は維持します。

```text
RSS dispatch ID
  → idempotencyKeyとしてenqueue
  → queue側が重複を排除
```

変更するのは、そのキーを巨大化する`inbox.jsonl`のtombstoneとして保持しないことです。

---

# 4. 推奨データモデル

SQLiteは**1ファイルだけ**にします。

例:

```text
data/queue/queue.sqlite3
```

NanoClawのようなinbound DBとoutbound DBへの分割はしません。

## `jobs`

agent実行の状態を管理します。

主なフィールド:

```text
id
source
group_id
session_id
channel_id

payload
result_payload

execution_status
attempt_count
next_attempt_at

lease_owner
lease_expires_at

started_at
agent_completed_at
created_at
updated_at

last_error_phase
last_error_type
last_error_message
last_error_at
```

`execution_status`は以下で十分です。

```text
queued
leased
running
succeeded
retry_wait
dead
```

状態遷移:

```text
queued
  → leased
  → running
      ├─→ succeeded
      ├─→ retry_wait → queued
      └─→ dead
```

## `deliveries`

Discord送信をagent実行とは別に管理します。

主なフィールド:

```text
id
job_id
destination_type
destination_id
payload

delivery_status
attempt_count
next_attempt_at

lease_owner
lease_expires_at

external_message_id
delivered_at

last_error_type
last_error_message
last_error_at
```

状態遷移:

```text
pending
  → leased
  → sending
      ├─→ delivered
      ├─→ retry_wait → pending
      └─→ dead
```

## `idempotency_keys`

メッセージ本文と冪等キーを分離します。

```text
key PRIMARY KEY
job_id
source
created_at
expires_at
```

初期段階では、安全性を優先してキーだけを長期保持します。

RSS本文全体をtombstoneとして残すのではなく、残るのは小さいキーとjob IDだけです。

---

# 5. 「完了」の定義を分離する

現在の大きな問題は、agent成功と処理全体の成功が同じように扱われていることです。

現在は概ね次の順序です。

```text
agent成功
  → inboxから完了扱いで除去
  → Discord送信
```

該当箇所:

- `/home/shi/ghq/github.com/shin902/my-discord-agent/src/queue/poller.ts:541-543`

そのため、agentが正常終了した後にDiscord送信だけ失敗すると、agent結果がqueueから消えています。

## 変更後

```text
1. jobをclaim
2. agentを実行
3. agent結果をDBに保存
4. jobをsucceededに更新
5. deliveryをpendingとして作成
6. Discordへ送信
7. deliveryをdeliveredに更新
```

重要なのは、手順3〜5を同じSQLite transactionにすることです。

これにより、Discord送信に失敗しても次回は、

```text
agentを再実行せず
保存済みの結果だけをDiscordへ再送
```

できます。

## 外部から見た総合状態

総合statusは保存せず、`jobs`と`deliveries`から計算する方が安全です。

| 状況                          | 表示する総合状態   |
| ----------------------------- | ------------------ |
| agent待機中・実行中           | `processing`       |
| agent成功、Discord未送信      | `delivery_pending` |
| agent成功、Discord送信成功    | `completed`        |
| agentがterminal failure       | `agent_failed`     |
| Discord送信がterminal failure | `delivery_failed`  |

これで「agentは完了したがDiscord送信が失敗した」という現在確認できない状態を表現できます。

---

# 6. RSS蓄積問題の解決

## 現在の原因

RSS dispatchは、以下の箇所でdispatch IDを冪等キーとして投入しています。

- `/home/shi/ghq/github.com/shin902/my-discord-agent/src/cron/jobs/rss-dispatch.ts:100-127`

成功後、`idempotencyKey`付きのレコードは物理削除されず、次のようなtombstoneになります。

```json
{
  "content": "",
  "completedAt": "...",
  "idempotencyKey": "..."
}
```

関連処理:

- `/home/shi/ghq/github.com/shin902/my-discord-agent/src/queue/inbox.ts:113-135`
- `/home/shi/ghq/github.com/shin902/my-discord-agent/src/queue/inbox.ts:161-180`

RSS dispatchごとにキーが異なるため、完了tombstoneが増え続けます。

## 推奨する解決方法

### 維持するもの

- RSSの`idempotencyKey`
- enqueue後に同一dispatchを重複追加しない性質
- producer再起動時の再試行

### 廃止するもの

- 完了したRSS本文を`inbox.jsonl`内に残すこと
- 冪等性のために本文レコードをtombstone化すること

### 新しい挙動

```text
RSS enqueue
  → idempotency_keysへキーを記録
  → jobsへ本文を記録
  → 完了後、jobsの本文をretentionに従って削除
  → idempotency keyだけを保持
```

これなら、RSS本文は`inbox.jsonl`に溜まりません。

## RSS producer側を変更しない理由

単純に`idempotencyKey`を外すと、次のクラッシュで重複します。

```text
inbox追加成功
  → プロセスクラッシュ
  → RSS記事のmarkArticlesRead未実行
  → 再起動
  → 同じRSS dispatchを再投入
```

現在の`idempotencyKey`は、このケースを防いでいます。

したがって、**RSS側の冪等キーを外す案は不採用**です。

---

# 7. クラッシュ時の復旧

## enqueueのDB commit前

```text
jobが存在しない
→ producerが再試行
```

## enqueueのDB commit後、RSSの既読化前

```text
RSSが同じidempotencyKeyで再試行
→ 既存jobを返す
→ 二重投入しない
```

## claim後、agent起動前

```text
leaseが期限切れ
→ queuedへ戻す
```

## agent実行中にhostがクラッシュ

```text
leaseが期限切れ
→ retry
```

ただし、agentが外部ツールで副作用を起こしていた場合、完全なexactly-onceにはできません。これはqueueだけでは解決できず、ツール側の冪等性が必要です。

## agent成功結果の保存後、Discord送信前

```text
job = succeeded
delivery = pending
→ 再起動後、agentを再実行せずdeliveryだけ再開
```

## Discord送信失敗

```text
delivery = retry_wait
→ backoff後に再送
```

## Discord送信成功直後、DB更新前にクラッシュ

ここだけは外部APIとのtransactionがないため、曖昧性が残ります。

```text
Discordには送信済み
DBではsending
→ 再送すると重複する可能性
```

完全に防ぐには、Discord側で利用できる場合に限り、

- deterministic nonce
- message IDの照合
-送信済みメッセージの検索

などが必要です。

**単一SQLite化しても、外部APIを含む完全なexactly-onceは保証できません。**

目標は以下に置くべきです。

> agent実行は可能な限り再実行しない。  
> deliveryはat-least-onceとして扱い、重複可能性を限定・観測可能にする。

---

# 8. エラー管理

現在のdead-letterはappend-only JSONLですが、これもactive stateには使わない方針です。

terminal failureはjobまたはdeliveryに保存します。

```text
last_error_phase
last_error_type
last_error_message
last_error_at
attempt_count
```

`last_error_phase`は最低限、次で分類します。

```text
claim
agent_start
agent_execution
agent_timeout
result_persist
delivery
```

これにより、単に「失敗した」ではなく、

```text
agentは成功した
Discord deliveryが7回失敗している
次回retryは10分後
```

まで確認可能になります。

`dead-letter.jsonl`を残す場合も、source of truthではなく監査用exportに限定します。

---

# 9. 段階的な導入方針

## Phase 1: queue storageの置き換え

- SQLite schema追加
- `appendInbox()`の外部インターフェースを維持
- `inbox.jsonl`のactive行を`jobs`へ移行
- 完了tombstoneは本文を移さず、冪等キーだけ移行
- producer側の変更を最小化

この段階でRSS tombstoneの増加は止まります。

## Phase 2: agent状態の永続化

- claim/lease導入
- `queued / running / succeeded / retry_wait / dead`
- timeoutとエラー詳細を保存
- 起動時にexpired leaseを回収

ここでagent完了状態を確認できるようになります。

## Phase 3: delivery分離

- agent結果を永続化
- `deliveries`を追加
- Discord送信を独立retry
- agent成功後にDiscord送信が失敗しても結果を失わない

## Phase 4: retentionと観測

- 完了job本文の削除
- 冪等キーの保持方針
- failed jobの保持期間
- status取得APIまたは管理コマンド
- queue件数、stale lease、retry件数のログ

## 将来必要になった場合だけ行うもの

RSS記事を「enqueue済み」ではなく「Discord delivery済み」で既読化したい場合は、別フェーズでRSS ack連携を追加します。

これは今回の「RSS内容がinboxに溜まる」問題の解決には不要です。

---

# 10. 想定変更範囲

## 推奨案

本番コード:

| 対象                       | 変更規模                    |
| -------------------------- | --------------------------: |
| `src/queue/inbox.ts`       | 大幅変更または互換wrapper化 |
| 新規SQLite store           | 約200〜350行                |
| `src/queue/poller.ts`      | 約100〜200行                |
| `src/queue/dead-letter.ts` | 約20〜60行                  |
| `src/cron/enqueue.ts`      | 約10〜30行                  |
| startup/migration          | 約50〜100行                 |

概算:

- **本番コード:** 5〜7ファイル、約400〜750行
- **テスト:** 3〜6ファイル、約300〜600行
- **合計:** 8〜13ファイル、約700〜1,350行

テストでは最低限、以下のクラッシュ境界を再現する必要があります。

- enqueue後のクラッシュ
- lease期限切れ
- agent失敗
- agent成功後のdelivery失敗
- RSS idempotency
- 既存JSONLの移行
- retry上限到達

## JSONLを維持する最小修正案

- 2〜4ファイル
- 本番コード約200〜400行
- テスト約150〜300行

ただし、以下が残ります。

- 全件走査
- 全ファイルrewrite
- lock/atomicity問題
- compaction
- tombstone retention
- claimとstatus更新のtransaction不足
- status queryの非効率
- append eventとsnapshotの二重管理

変更量は少なく見えますが、独自DBを再実装する方向になります。そのため推奨しません。

---

# 11. 不採用案

## 完了tombstoneを単純削除する

**不採用理由:** RSS producerのクラッシュ復旧で重複投入が起きるため。

## RSSから`idempotencyKey`を外す

**不採用理由:** enqueue成功とRSS既読化の間のクラッシュで重複するため。

## JSONLにstatusイベントを追記し続ける

例:

```text
enqueued
claimed
running
succeeded
delivered
```

**不採用理由:** event sourcing、snapshot、compaction、lock、復旧を自前実装することになり、KISSに反するため。

## inboxとdeliveryで別々のDBを使う

**不採用理由:** one-shot処理では単一transactionでjob成功とdelivery作成を確定した方が安全で単純なため。

## NanoClaw型の長寿命コンテナへ移行する

**不採用理由:** background agent、実行中の追加入力、pause/resumeが現在の要件ではないため。

## RSS記事をdelivery成功まで未読のままにする

**今回は不採用:** delivery障害中に同じ記事のclaimが滞留し、RSS queueの意味も「未読」から「未配送」に変わるため。必要なら別途`dispatch_status`を導入すべきです。

---

# 最終方針

次の方針で固めるのが最適です。

> **`inbox.jsonl`を延命せず、inbox subsystem内部を単一SQLiteのhost-owned queueに置き換える。**  
> **`jobs`でagent実行、`deliveries`でDiscord送信、`idempotency_keys`でRSS重複防止を管理する。**  
> **外部のenqueue APIは維持し、RSS producerやagent runtimeへの変更は最小限にする。**

この方針で同時に改善できるもの:

- agentが完了したか確認できる
- agent成功とDiscord送信成功を区別できる
- statusを永続化できる
- エラーの段階と内容を保存できる
- retryを再起動後も継続できる
- staleな処理をleaseで回収できる
- agent結果を失わずdeliveryだけ再試行できる
- RSS本文のtombstone蓄積を止められる
- RSSの冪等性を維持できる
- NanoClawの2DBや長寿命コンテナを導入せずに済む

残る制約:

- agentが外部で起こした副作用のexactly-once
- Discord送信成功直後にhostが落ちた場合の送信重複
- RSS記事の「配送完了」をRSS DB側で追跡すること

これらは`inbox`だけでは完全解決できないため、今回のスコープ外とするのが妥当です。

追加の実装・ファイル変更は一切行っていません。