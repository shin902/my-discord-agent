# Agent Memory shadow capture設計

この文書は、Agent MemoryのL0 shadow captureを変更・レビューするときに必要な内部境界を説明する。利用者・運用者から見た記録対象と具体的な挙動は [`../agent-memory.md`](../agent-memory.md) を参照する。

## 目的

通常Discord会話のuser/assistant 1往復をTencentDB Agent Memoryへ非同期送信し、MemoryCoreの障害やprocess restartが通常回答へ波及しないdurableなL0 capture経路を提供する。

設計上の主な保証は次のとおり。

- 明示的に許可されたgroupの通常会話だけを対象にする
- 通常Agent実行とMemoryCore送信を分離する
- 通常回答結果とshadow admissionをruntime.sqliteへ原子的に保存する
- 未送信jobはprocess restart後も再開できる
- 送信直前にconfigとchannel→group mappingを再確認する
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
  │  AgentMemorySubmission + AgentMemoryAdmissionを作成
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
  │  fresh config read
  │  fresh channel→group mapping read
  │  admission fingerprint・scope照合
  ├─ revoked/rotated → remote送信せずcompleted
  └─ current          → AgentMemoryClient.addConversation
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

## 3段階のadmission

### 1. intake admission

`src/discord/intake.ts` は通常のgroup/session routingを解決した後、現在のAgent Memory configを読む。`isAgentMemoryEligible()`を満たした場合だけ、Discord author IDを`InboxMessage.userId`へ保存する。

この段階の目的は、すべての通常queue payloadへuser identityを無条件に追加せず、capture候補にだけ後続処理で必要なidentityを保持することにある。

config readやeligibility確認が失敗した場合はmemory captureを諦め、通常Discord intakeを継続する。

### 2. completion admission

通常Agentが非空の最終回答を返した後、`prepareMemoryShadowJob()`がconfigをfresh readし、再度eligibilityを確認する。対象なら次を作る。

- `AgentMemorySubmission`: remoteへ送るscopeとuser/assistant messages
- `AgentMemoryAdmission`: group、routing、destination、endpoint、scope、token selectorのsnapshot
- local idempotency key: `agent-memory-shadow:<source job ID>`

この準備が失敗しても、source resultとDiscord deliveryは通常どおりcommitする。shadow modeは通常応答のcritical pathに対してbest-effortである。

### 3. execution revalidation

shadow jobをclaimした`processMemoryShadowJob()`は、remote I/Oの直前に次を確認する。

- configが現在も有効
- groupが現在も`eligibleGroups`に含まれる
- `routingChannelId`のfresh mappingが同じgroupを指す
- 保存済みadmissionが現在config・routingから再構築したadmissionと一致する
- submission scopeがadmissionのteam/agent/user/sessionと一致する

不一致はerrorやdead-letterではなく、privacy revocationとしてremote送信をskipし、jobを完了する。

## persisted payload

既存の`InboxMessage` payloadへ次のoptional fieldを追加している。

| field | 用途 |
|---|---|
| `userId` | intake時にeligibleだった人間のDiscord user identity |
| `routingChannelId` | thread destinationとは別に、group mappingを再確認するconfigured channel |
| `memoryShadow` | remoteへ送る`AgentMemorySubmission` |
| `memoryShadowAdmission` | 送信可否を再確認するsnapshotとfingerprint |

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

### AgentMemoryAdmission

admission fingerprintには次を含める。

- group name
- routing channel ID
- destination channel ID
- MemoryCore base URL
- service ID
- bearer tokenの環境変数名
- team ID
- agent ID
- user ID
- original session ID

Bearer token値は含めない。token rotationは同じselectorの新しい値として扱い、remote送信時に環境変数から読む。

## atomicity boundary

`QueueRepository.commitResult()`は通常source jobのterminal result、Discord delivery rows、optional shadow jobを同じSQLite transactionで保存する。

保証すること:

- source resultだけcompletedになり、shadow admissionだけ失われる中間状態を作らない
- transactionがrollbackした場合、source completion・delivery・shadow admissionをまとめてrollbackする
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
| fresh revalidation mismatch | なし | remote送信せずcompleted |
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
- Bearer tokenは送信時に環境変数から読み、config・admission・queue payloadへ値を保存しない
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
- `shadow job skipped (disabled/revoked/rotated)`: execution revalidation不一致
- `shadow job preparation failed`: sourceは成功したがshadow admissionを作れなかった

通常Agentの応答時間やDiscord配送のsuccessと、shadow submissionのsuccessは別に観測する。

## code map

| file | responsibility |
|---|---|
| `src/config/agent-memory.ts` | config schema、URL制約、eligibility policy、fresh config load |
| `src/discord/intake.ts` | Discord group/session解決、intake admission、eligible user IDの保持 |
| `src/memory/agent-memory.ts` | submission/admission型、fingerprint、HTTP client、payload構築 |
| `src/queue/types.ts` | durable queue payloadにmemory fieldを定義 |
| `src/queue/repository.ts` | source result・delivery・shadow admissionのatomic commit |
| `src/queue/poller.ts` | completion admission、memory job分岐、fresh revalidation、retry/dead-letter接続 |
| `src/queue/observability.ts` | memory内部jobが通常Agent観測を歪めないための分類 |
| `docs/config.md` | operator向けconfig reference |
| `docs/agent-memory.md` | 記録対象・payload・失敗時挙動の利用者向け仕様 |

## test map

| test file | 主に固定するcontract |
|---|---|
| `src/config/agent-memory.test.ts` | execution時にfresh configを読むこと |
| `src/config/groups.test.ts` | fresh channel→group mapping |
| `src/discord/intake.test.ts` | eligibleな人間identityだけをqueueへ保持すること |
| `src/memory/agent-memory.test.ts` | URL/header/payload/error分類、fingerprint、secret非露出 |
| `src/queue/repository.test.ts` | source resultとshadow admissionのtransactional atomicity/idempotency |
| `src/queue/poller.test.ts` | 対象・除外・revocation・retry/dead-letter・通常応答非干渉 |
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

### config変更はpending jobをskipする

endpointやscopeを変更した場合、既存pending jobを新しいdestinationへ自動転送せずskipする。privacyを優先した挙動だが、設定migration時には未送信分が欠落し得る。必要なら変更前にqueueをdrainする。

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

それまではL0 captureのdurability、privacy revalidation、通常回答からのfailure isolationを現在の契約として維持する。
