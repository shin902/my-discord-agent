# Agent Memory shadow capture設計

この文書は、Agent MemoryのL0 shadow captureを変更・レビューするときに必要な内部境界を説明する。利用者・運用者から見た記録対象と具体的な挙動は [`../agent-memory.md`](../agent-memory.md) を参照する。

## 目的

通常Discord会話のuser/assistant 1往復をTencentDB Agent Memoryへ非同期送信し、MemoryCoreの障害やprocess restartが通常回答へ波及しないdurableなL0 capture経路を提供する。

設計上の主な保証は次のとおり。

- 明示的に許可されたgroupの通常会話だけを対象にする
- 通常Agent実行とMemoryCore送信を分離する
- 通常回答結果とshadow jobをruntime.sqliteへ原子的に保存する
- 未送信jobはprocess restart後も再開できる
- configとchannel→group mappingはprocess lifetime中cached値を使う
- MemoryCore失敗は通常回答・Discord配送を巻き戻さない
- secret値をconfigやqueue payloadへ保存しない

## non-goals

この経路は次を担当しない。

- L1/L2/L3の抽出品質やconsolidation algorithm
- recall、context bootstrap、通常回答へのmemory injection
- MemoryCore内部workerのbatch/逐次切り替え
- 通常会話を優先するLLM resource scheduling
- Discord edit/deleteとremote memoryの同期
- remote exactly-once
- MemoryCore上のretention・削除・forget操作

## end-to-end flow

```text
Discord MessageCreate
  │
  │  1. group/session解決
  │  2. intake時eligibility確認
  │  3. eligibleな場合だけuserIdをqueue payloadへ保存
  ▼
runtime.sqlite: source job
  │
  │  QueueRepository.claim
  ▼
queue/poller.ts: normal agent execution
  │
  │  provider lock取得
  │  Agent最終回答を生成
  │  回答完了時eligibility確認
  │  AgentMemorySubmissionを作成
  ▼
QueueRepository.commitResult transaction
  ├─ source resultをcompletedへ更新
  ├─ Discord delivery rowsを作成
  └─ memory shadow jobをenqueue
       │
       │  source jobとは別のdurable job
       ▼
runtime.sqlite: shadow job
  │
  │  QueueRepository.claim
  ▼
queue/poller.ts: memory branch
  │
  │  cached config・group mappingでenabled/eligibleを確認
  └─ eligible         → AgentMemoryClient.addConversation
                              │
                              ▼
                    POST /v3/conversation/add
                              │
                  ┌───────────┴───────────┐
                  │                       │
                success                failure
                  │                       │
              completed          retry_wait / dead_letter
```

MemoryCore受理後のL1/L2/L3処理はこの図の外側にある。

## 設定ライフタイムとadmission

Agent Memoryのruntime configとgroup mappingはcached loaderから読み込み、process lifetime中はfresh readしない。`enabled`、`eligibleGroups`、接続先、scope、Bearer token selector、channel mappingを変更した場合はrestartで反映する。hot reload / hot revocation / config rotation検知は保証しない。

### 1. intake admission

`src/discord/intake.ts` は通常のgroup/session routingを解決した後、cached Agent Memory configを読む。`isAgentMemoryEligible()`を満たした場合だけDiscord author IDを`InboxMessage.userId`へ保存する。失敗時はmemory captureを諦め、通常Discord intakeを継続する。

### 2. completion admission

通常Agentが非空の最終回答を返した後、`prepareMemoryShadowJob()`が同じprocess-lifetime configでeligibilityを確認し、対象なら`AgentMemorySubmission`とlocal idempotency key（`agent-memory-shadow:<source job ID>`）を作る。設定世代のsnapshot、fingerprint、実行時の全field比較は保存・実行しない。この準備が失敗してもsource resultとDiscord deliveryは通常どおりcommitする。

### 3. execution

shadow jobをclaimした`processMemoryShadowJob()`はcached configで`enabled`と`eligibleGroups`だけを確認し、対象なら`AgentMemoryClient.addConversation()`を呼ぶ。scopeはsubmission payloadとして維持し、Bearer tokenは送信時にselectorの環境変数から読む。設定不一致のhot revocationを理由に実行時fresh readや送信抑止は行わない。

## persisted payload

既存の`InboxMessage` payloadへ次のoptional fieldを追加している。

| field | 用途 |
|---|---|
| `userId` | intake時にeligibleだった人間のDiscord user identity |
| `routingChannelId` | 通常queueのrouting metadata（Agent Memoryの再検証には使わない） |
| `memoryShadow` | remoteへ送る`AgentMemorySubmission` |

shadow job自身は次のqueue identityを使う。

```text
sessionId = memory-shadow:<source session ID>
content   = memory-shadow
```

remoteへ送る`session_id`はprefix付きqueue sessionではなく、`memoryShadow.scope.sessionId`に保持した元のsession IDである。

### AgentMemorySubmission

```ts
interface AgentMemorySubmission {
  scope: {
    teamId: string;
    agentId: string;
    userId: string;
    sessionId: string;
  };
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: string;
  }>;
}
```

## atomicity boundary

`QueueRepository.commitResult()`は通常source jobのterminal result、Discord delivery rows、optional shadow jobを同じSQLite transactionで保存する。

保証すること:

- source resultだけcompletedになり、shadow jobだけ失われる中間状態を作らない
- transactionがrollbackした場合、source completion・delivery・shadow jobをまとめてrollbackする
- remote MemoryCore I/Oはtransaction外で行う

保証しないこと:

- Discordへの実配送とMemoryCore送信の完了順
- Discord配送成功とMemoryCore成功の同一transaction
- MemoryCore受理後のremote exactly-once

## idempotencyとdelivery semantics

local shadow jobはsource job IDから決定したidempotency keyを持つ。これにより、同じsource completionを再処理しても別のlocal shadow jobを増やしにくい。

remote APIにはclient idempotency keyを送らないため、delivery semanticsはat-least-onceである。

```text
MemoryCoreがconversationを受理
  ↓
HTTP response消失、またはlocal complete前にprocess crash
  ↓
shadow jobを再試行
  ↓
同じ1往復がremoteへ重複する可能性
```

この重複可能性を隠してexactly-onceとは表現しない。

## failure boundary

| failure point | source responseへの影響 | shadow側の処理 |
|---|---|---|
| intake config/eligibility read | なし | `userId`を付けずcapture候補から外す |
| completion preparation | なし | shadow jobを作らずlog |
| source result transaction | source jobの通常failure handling | shadowも同時に未commit |
| missing bearer token env | なし | non-retryable dead-letter |
| timeout / network / 408 / 429 / 5xx | なし | queue retry policyへ委譲 |
| その他の恒久API error | なし | dead-letter |
| process restart before remote send | なし | runtime.sqliteから再claim |
| remote accept後・local complete前のcrash | なし | 再送され重複し得る |

pollerはretry回数やbackoffを独自実装せず、既存`QueueRepository.failAttempt()`へ委譲する。

## HTTP・secret boundary

`AgentMemoryClient`は次を守る。

- endpointは`baseUrl`へ`/v3/conversation/add`を追加して構築する
- `http://`はliteral loopbackの`127.0.0.1`または`[::1]`だけを許可する
- 非loopbackはHTTPS必須
- URLへのcredential、query、fragmentを禁止する
- redirectは`redirect: "error"`で拒否する
- Bearer tokenは送信時に環境変数から読み、config・queue payloadへ値を保存しない
- response bodyやsecretをerror messageへ展開しない

privacy上の注意として、conversation payloadにはDiscord user IDとsession IDをそのまま使用する。session modeによってはsession IDがDiscord channel/thread IDである。

## scheduling boundary

shadow jobは既存runtime queueへ入るが、通常Agent実行ではないためprovider mutexを取得しない。pollerはMemoryCoreへの短いHTTP requestまでを処理し、MemoryCore内部のanalysis LLMは直接管理しない。

そのため、通常AgentとMemoryCore analysisが同じ同時実行数1のローカルLLM endpointを使っても、`my-discord-agent`のprovider lockは両者を共通制御できない。現在の運用ではMemoryCore analysisを別providerへ分離する。

将来batch/cron modeやpriority schedulingを追加するときは、L0のdurable captureとMemoryCore analysisのcompute schedulingを別問題として扱う。L0 admissionまでまとめて遅延させる必要はない。

## observability

Agent Memory固有のlog prefixは`[agent-memory]`である。

- `shadow job admitted`: local transactionでshadow jobを保存
- `shadow submission accepted`: remote成功後にlocal jobを完了
- `shadow submission failed`: remote attempt失敗
- `shadow submission dead-lettered`: terminal failure
- `shadow job skipped (disabled/not eligible)`: cached configで送信対象外
- `shadow job preparation failed`: sourceは成功したがshadow jobを作れなかった

通常Agentの応答時間やDiscord配送のsuccessと、shadow submissionのsuccessは別に観測する。

## code map

| file | responsibility |
|---|---|
| `src/config/agent-memory.ts` | config schema、URL制約、eligibility policy、cached config load |
| `src/discord/intake.ts` | Discord group/session解決、intake admission、eligible user IDの保持 |
| `src/memory/agent-memory.ts` | submission型、HTTP client、payload構築 |
| `src/queue/types.ts` | durable queue payloadにmemory fieldを定義 |
| `src/queue/repository.ts` | source result・delivery・shadow jobのatomic commit |
| `src/queue/poller.ts` | completion admission、memory job分岐、cached eligibility、retry/dead-letter接続 |
| `src/queue/observability.ts` | memory内部jobが通常Agent観測を歪めないための分類 |
| `docs/config.md` | operator向けconfig reference |
| `docs/agent-memory.md` | 記録対象・payload・失敗時挙動の利用者向け仕様 |

## test map

| test file | 主に固定するcontract |
|---|---|
| `src/config/agent-memory.test.ts` | cached process configを使うこと |
| `src/config/groups.test.ts` | cached channel→group mapping |
| `src/discord/intake.test.ts` | eligibleな人間identityだけをqueueへ保持すること |
| `src/memory/agent-memory.test.ts` | URL/header/payload/error分類、secret非露出 |
| `src/queue/repository.test.ts` | source resultとshadow jobのtransactional atomicity/idempotency |
| `src/queue/poller.test.ts` | 対象・除外・cached eligibility・retry/dead-letter・通常応答非干渉 |
| `src/queue/observability.test.ts` | memory内部jobのobservability分類 |

## 既知のtrade-off

### 汎用queue payloadとの結合

memory shadow jobは専用tableではなく、既存`jobs.payload_json`のoptional fieldで表現している。既存lease、fencing、retry、dead-letter、restart recoveryを再利用できる一方、`InboxMessage`は複数job kindをoptional fieldで表す隠れたsum typeになっている。

現時点ではjob kindを増やさず、この実装を維持する。次の条件が発生したら、専用`agent_memory_outbox`または明示的なdiscriminated job typeを比較する。

- memory固有jobがcapture以外にも複数増える
- batch、delete、revoke、recall等が同じpayloadへ追加される
- memory変更のたびに通常queue/poller/repository全体を触る必要が出る
- 通常queueのclaim、metrics、retentionがmemory事情で歪む
- persisted payload migrationが日常的な変更を妨げる

### config変更はrestartで反映する

endpointやscopeを変更しても、process lifetime中はpending jobの送信時にfresh readや世代比較を行わない。設定変更を反映するにはrestartする。再起動後に未完了jobを現行設定で処理するか、`enabled` / `eligibleGroups` によりskipするかはcached configの値に従う。

### backfill・edit/delete

human startup backfillはcaptureされ得る。MessageCreate後のedit/deleteはremoteへ反映しない。これらは現行scopeの明示的な制約である。

## 将来の再設計条件

次の要件が具体化した時点で別PRとして設計する。

- MemoryCore analysisのrealtime / batch / cron切り替え
- 通常会話優先の共有LLM broker、abort、preemption
- per-message opt-out、明示的forget、Discord delete連動
- startup backfillのmemory専用policy
- remote idempotencyまたはdedup protocol
- memory backendの複数化
- dedicated outbox / discriminated queue job migration

それまではL0 captureのdurability、設定ライフタイム境界、通常回答からのfailure isolationを現在の契約として維持する。
