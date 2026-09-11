# Agent Memory export

Agent Memoryはcanonical session trajectoryから作る派生projectionです。cronは実行機会とbackend設定を持ち、処理は既存runtime queueへ委譲します。my-discord-agentはrecall、prompt injection、embeddingを実装せず、L0→L1→L2→L3の生成・検索はTencentDB Agent Memory sidecarへ委譲します。

```text
config/cron.json (schedule + backend settings)
  → cron handler (enqueueのみ)
  → runtime.sqlite (queue / ordering / lease / fencing / retry / dead-letter / recovery)
  → Memory export worker
      → runtime.sqlite (source jobの成功commit / fencing一致をread-only確認)
      → data/sessions/<group>/sessions.sqlite (本文をread-only取得)
      → Memory Backend Adapter → TencentDB / other backend
      → data/memory-export.sqlite (export成功markerのみ)
```

## 設定

backendごとに `config/cron.json` へhandler付きjobを1つ定義します。[example](../config/cron.example.json) は誤送信防止のためdisabledです。対象groupを確認して明示的に有効化してください。通常のgroup/channel AgentConfigやDiscord配送設定は不要です。

```json
{
  "id": "memory-tencent-main",
  "schedule": "1m",
  "enabled": true,
  "handler": "jobs/memory-export.ts",
  "settings": {
    "type": "tencentdb",
    "eligibleGroups": ["main"],
    "batchSize": 50,
    "baseUrl": "http://127.0.0.1:8420",
    "serviceId": "default",
    "teamId": "default",
    "agentId": "my-discord-agent",
    "bearerTokenEnv": "MEMORY_CORE_GATEWAY_API_KEY",
    "timeoutMs": 10000
  }
}
```

| settings | 契約 |
|---|---|
| `type` | 現在は `tencentdb` |
| `eligibleGroups` | exportを許可するgroup名の明示リスト（1件以上）。private会話の送信先を運用者が確認する |
| `batchSize` | 1 jobで成功させるturn数の上限。1〜1000、既定50 |
| `baseUrl` | 既定 `http://127.0.0.1:8420`。非loopbackはHTTPS必須。HTTPはliteral `127.0.0.1` / `[::1]` のみ。埋め込みcredentials、query、fragmentは禁止。redirectは追従しない |
| `serviceId` | `x-tdai-service-id`。既定 `default` |
| `teamId` / `agentId` | TencentDB scope。既定 `default` / `my-discord-agent` |
| `bearerTokenEnv` | Bearer tokenを読む環境変数名。値をJSONへ書かない。MemoryCore v3 data-planeでは実質必須 |
| `timeoutMs` | 1 HTTP requestのtimeout（body読み込みを含む）。1〜120000ms、既定10000 |

## 品質設定（TencentDB sidecar）

### 日本語のL1/L2/L3 custom prompt

upstreamの `/v3/memory-prompt/*` を使い、L1（抽出）、L2（Scene統合）、L3（persona）を日本語会話向けに調整できます。設定はTencentDBのprompt storeに保存され、my-discord-agentのqueueや独自RAGには保存しません。次のfixtureは `team_id=default` / `agent_id=my-discord-agent` に3層をagent scopeで適用します。

```bash
pnpm memory-core:prompts
```

このコマンドは `config/memory-core-prompts.example.json` を読み、同名・同layerのpromptを更新または作成してから `/v3/memory-prompt/set` で適用します。別scopeや別fixtureを使う場合は `MEMORY_CORE_PROMPTS_FILE`、`MEMORY_CORE_TEAM_ID`、`MEMORY_CORE_AGENT_ID` を指定してください。v3 data-planeのBearer要件のため `.env` の `MEMORY_CORE_GATEWAY_API_KEY` を使用します。

### Embedding（optional）

標準例は `none` です。CLIProxyAPI等のLLM endpointが `/embeddings` を提供するとは限らないため、未検証のembedding providerを有効化しません。dense embeddingを利用できるOpenAI-compatible endpointがある場合だけ、`.env` で次を設定してsidecarを再起動します。

```env
MEMORY_CORE_EMBEDDING_PROVIDER=openai
MEMORY_CORE_EMBEDDING_API_BASE_URL=https://api.openai.com/v1
MEMORY_CORE_EMBEDDING_API_KEY=<embedding-provider-key>
MEMORY_CORE_EMBEDDING_MODEL=text-embedding-3-small
```

`config/memory-core.example.yaml` は上記modelのdimensionを `1536` として指定しています。別modelを使う場合は、そのmodelの出力dimensionへ変更し、既存vector indexとの不一致を避けてください。TencentDB側の `hybrid` はdense+sparseを使いますが、アプリ側に独自のrecall・reranker・relevance gateは追加していません。provider未設定時は従来どおりkeyword/BM25中心で動作します。

### L1→L2のactivity timestamp patch

upstreamのL2 runnerは従来、L1の `created_at` だけをScene入力へ渡し、L1 `metadata.activity_start_time` / `metadata.activity_end_time` を落としていました。`created_at` は記憶生成時刻であり、Discord活動時刻ではありません。

再現可能な最小patchを `patches/tencentdb-memory-core-activity-metadata.patch` に固定し、upstream `feat/server_team` commit `0468a2a5b50eaafc54758ed1e2e6609472e5b6ce` へ適用します。これはL2入力のmetadataへactivity start/endだけを追加し、checkpoint、team+agent scope、標準schema/type、persona.md protocolは変更しません。custom imageを使う場合は次を実行し、`.env` に `MEMORY_CORE_IMAGE=my-discord-agent-memory-core:quality` を設定してから起動します。

```bash
pnpm memory-core:build
MEMORY_CORE_IMAGE=my-discord-agent-memory-core:quality pnpm memory-core up -d
```

公式imageの既定値は変更していません。custom imageを使わない場合、L1 metadataのL2入力へのforwardは行われないため、patch適用済みimageかどうかをhealthだけでなくbuildログ・image tagで確認してください。

MemoryCore sidecarの起動・鍵設定は [config.md](config.md#memorycore-sidecarの起動) を参照してください。

cron job IDは安定したbackend / export namespaceです。同じlogical backendならIDを維持します。別のbackend、team/agent scope等へ既存履歴を再exportしたい場合は**新しいcron job ID**を使います。

実行時のauthorityはstartupでロードされたcron設定cacheです。変更はrestartで反映し、process中のfresh read・hot reloadはしません。restart前にenqueueされたjobも新processのcacheで処理します。対応IDが削除、disabled、または別handlerへ変更されていれば、remote exportせず正常完了（no-op）します。handlerの同一性はcron loaderが解決した関数で判定するため、`./jobs/memory-export.ts`等の同値pathやloaderが受理する拡張子aliasでもexportできます。旧settings snapshot、generation、fingerprintの復元・比較はありません。settings不正・未設定credentialはworkerでnon-retryable failureになります。

## canonical sourceとturn

通常human Discord message（Default `0` / Reply `19`）のuser entryには、Memoryの設定と無関係に汎用provenanceを保存します。

```json
{"kind":"discord","sourceId":"<Discord message ID>","actorId":"<Discord user ID>","messageType":0,"createdAt":"2026-09-01T01:00:00.000Z"}
```

`session_entries.source_json` はnullableです。会話本文・session identityは既存columnを使い、candidate flagやbackend設定は追加しません。source metadataはLLM contextへ混ぜません。auto-thread起点でも、返信先message IDとは別に元のDiscord message IDを保持します。`createdAt`は元Discord messageの作成時刻です。exportのuser timestampにはこれを使い、startup backfill等の処理時刻と混同しません。canonical user entryのtimestampは処理時刻のまま維持し、`createdAt`のない旧provenanceだけはそのentry timestampへfallbackします。assistantはcanonical entryの生成時刻を使います。

通常会話のrunのentryには、本文・sourceとは別に `execution_json: {"jobId":"<runtime job ID>","fencingToken":1}` を保存します。これは汎用の実行identityであり、成功markerではありません。LLM contextには含めず、sandboxへruntime DBを公開することもありません。

- source jobがruntime DB上で成功commit済み（`completed`、`succeeded`、`result_state: succeeded`）であり、保存されたfencing tokenが一致することを**応答を読む前に**確認します。sessionに`stop`があるだけではexportしません。
- 同じ実行identityのentryだけから最終assistantを取得し、正常終了（`stopReason: stop`）、非空text、errorなしの場合だけ対応付けます。別試行の遅延書き込みを混ぜず、最終assistantが不適格な場合も途中の`stop`へfallbackしません。
- 未commit、assistant未到着、error / aborted、tool call途中、length終了、空responseはexportしません。後続batchで成功commit済みの試行を再評価できます。
- 別jobのpromptや応答は実行identityで分離します。同じrun内のfollow-up promptがある場合も、Agentが返す最終assistantを使います。`./command nonexistent`等のAgent起動前に生成する応答も、user＋assistantと実行identityをcanonicalへ保存して同じ条件で判定します。
- Bot Task、Subagent、cron、RSS、mail、Discord Bot自身の発言、slash commandには初版のDiscord会話provenanceを付けません。
- 送信元はsession DBのみです。通常runtime jobのpayload/result、Discord deliveryから本文を再構築しません。本文はcanonicalに保存されたtextです（添付ファイル案内等を含む場合があります）。thinkingやtool payloadは送信しません。
- `<NO_REPLY>` はDiscord配送の抑制であり、非空の正常assistantとして保存されていればexport対象になり得ます。

session schema v1/v2は通常の書き込み経路でv3へ更新されます。migrationはwrite lock取得後にschema versionを再確認し、同じgroupの並行run/containerによる二重ALTERを防ぎます。export側はDB作成・migrationをしません。source provenanceや実行identityのない既存履歴は本文やruntime queueから推測・backfillしません。

## queueと成功ledger

cron handlerは1回につきbounded batchのjobを1件enqueueするだけです。payloadは `jobKind: memory-export`、cron job ID、`sessionId: memory-export:<cronJobId>`、既存queue envelopeの最小metadataのみです。既存Inbox型に必要な `groupName` / `channelId` / `content` は空文字で、routing・本文の意味を持ちません。会話本文、turn固定リスト、接続設定、scope、secret selector、eligible判定、設定snapshotを永続化しません。

同一backendのjobは既存session orderingで直列化し、retry待ちの先行jobも追い越しません。backend間は独立です。通常pollerのheartbeat・lease・fencing・retry・dead-letter・restart recoveryをそのまま利用し、Agent container、LLM provider lock、Discord deliveryは使いません。内部jobはqueue metricsには含め、Agent metricsからはjob discriminatorで除外します。

ledgerは次の成功事実だけです。

```sql
CREATE TABLE exports (
  backend_id TEXT NOT NULL,
  group_name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  exported_at TEXT NOT NULL,
  PRIMARY KEY (backend_id, group_name, source_kind, source_id)
);
```

backendが1turnを受理した直後にmarkerを書きます。batch途中で失敗してもそれまでのmarkerは残り、queue retryでは成功済みturnを送信しません。ledgerにpending、attempt、lease、retry、error、payload、configはありません。

network、timeout、408、429、5xxは既存queueのretryへ、明確な設定不備や恒久API errorはnon-retryableとしてdead-letterへ進みます。失敗したturn以後はそのbatchで送信しません。後続の定期cron jobは新しい実行機会なので、dead-letterが未export sourceを永久に除外することはありません。backend停止時はcronをdisabledにしてrestartすると、待機jobもno-opで収束できます。

## 制約と運用

- **at-least-once**: remote受理後・marker保存前のcrashでは重複が起こり得ます。2-phase commit、outbox、remote idempotency emulationはありません。
- ledgerだけを削除すると、成功commitを検証できるturnがremoteへ再送されます。再構築は新しいbackend namespaceとcron IDを組み合わせるか、backend namespaceと対応markerを一緒にresetしてください。
- source jobの成功記録がruntime retention等で失われたturnは、安全側で対象外にします。export/re-exportが必要な期間はsession DBに加えて対応runtime jobも保持してください。retention archiveからの自動復元・照合はしません。
- 確認するのはsource jobの結果commitであり、Discordの`sent`ではありません。配送retryはAgentを再実行せず、Memory exportの判定とも独立です。
- groupは設定順、group内はsource entry追加順に走査します。batch数はremote成功turn数を制限しますが、履歴の走査量を制限するcursor stateは持ちません。大きな履歴や先頭groupの継続的な大量流入では走査コスト・後続groupの遅延が増えます。
- 通常queue/cronと同じ単一host process・Discord readinessの起動条件を引き継ぎます。Memory専用schedulerやmulti-host lockはありません。
- queue状態は [runtime-dbスキル](../.pi/skills/runtime-db/SKILL.md) のread-only手順で確認します。`cronJobId` / `jobKind` と通常のjob statusを使い、成功件数はledgerをread-onlyで確認します。runtime backupにsession DB・export ledgerは含まれません（[storage.md](storage.md)）。

### 旧capture経路からのrollout

旧shadow job互換実行・payload migrationはありません。**更新前に旧runtimeで未完了shadow jobをdrainし、queueに残っていないことをread-onlyで確認してから停止**してください。drainできない場合はrolloutを止め、既存queueの運用手順で対処します。ad-hocなSQL更新でleaseやdelivery状態を改変しないでください。

旧top-level `config/config.json.agentMemory` を削除し、必要なbackendを `config/cron.json` に移してrestartします。旧設定は新runtimeでは参照されません。新provenanceと実行identityが保存される以降の成功commit済み会話が対象となり、既存remote memoryはそのまま保持できます。新経路のqueue、session、ledgerを確認してから通常運用へ戻してください。
