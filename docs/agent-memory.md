# Agent Memory export

Agent Memoryはcanonical session trajectoryから作る派生projectionです。cronは実行機会とbackend設定を持ち、処理は既存runtime queueへ委譲します。recall、prompt injection、embeddingは実装しません。

```text
config/cron.json (schedule + backend settings)
  → cron handler (enqueueのみ)
  → runtime.sqlite (queue / ordering / lease / fencing / retry / dead-letter / recovery)
  → Memory export worker
      → data/sessions/<group>/sessions.sqlite (read-only)
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

MemoryCore sidecarの起動・鍵設定は [config.md](config.md#memorycore-sidecarの起動) を参照してください。

cron job IDは安定したbackend / export namespaceです。同じlogical backendならIDを維持します。別のbackend、team/agent scope等へ既存履歴を再exportしたい場合は**新しいcron job ID**を使います。

実行時のauthorityはstartupでロードされたcron設定cacheです。変更はrestartで反映し、process中のfresh read・hot reloadはしません。restart前にenqueueされたjobも新processのcacheで処理します。対応IDが削除、disabled、または別handlerへ変更されていれば、remote exportせず正常完了（no-op）します。旧settings snapshot、generation、fingerprintの復元・比較はありません。settings不正・未設定credentialはworkerでnon-retryable failureになります。

## canonical sourceとturn

通常human Discord message（Default `0` / Reply `19`）のuser entryには、Memoryの設定と無関係に汎用provenanceを保存します。

```json
{"kind":"discord","sourceId":"<Discord message ID>","actorId":"<Discord user ID>","messageType":0,"createdAt":"2026-09-01T01:00:00.000Z"}
```

`session_entries.source_json` はnullableです。会話本文・session identityは既存columnを使い、candidate flagやbackend設定は追加しません。source metadataはLLM contextへ混ぜません。auto-thread起点でも、返信先message IDとは別に元のDiscord message IDを保持します。`createdAt`は元Discord messageの作成時刻です。exportのuser timestampにはこれを使い、startup backfill等の処理時刻と混同しません。canonical user entryのtimestampは処理時刻のまま維持し、`createdAt`のない旧provenanceだけはそのentry timestampへfallbackします。assistantはcanonical entryの生成時刻を使います。

- sourced userから次のsourced userまでを探索し、最後の正常終了（`stopReason: stop`）、非空text、errorなしのassistantを対応付けます。
- assistant未到着、error / abortedのみ、tool call途中、length終了、空responseはexportしません。次のjobが未完了turnを再評価できます。
- provenanceのないuser promptに達したら、それ以降の回答を元humanへ誤帰属させません。
- Bot Task、Subagent、cron、RSS、mail、Discord Bot自身の発言、slash commandには初版のDiscord会話provenanceを付けません。
- 送信元はsession DBのみです。通常runtime jobのpayload/result、Discord deliveryから本文を再構築しません。本文はcanonicalに保存されたtextです（添付ファイル案内等を含む場合があります）。thinkingやtool payloadは送信しません。
- `<NO_REPLY>` はDiscord配送の抑制であり、非空の正常assistantとして保存されていればexport対象になり得ます。

session schema v1は通常の書き込み経路でv2へ更新されます。migrationはwrite lock取得後にschema versionを再確認し、同じgroupの並行run/containerによる二重ALTERを防ぎます。export側はDB作成・migrationをしません。provenanceのない既存履歴は本文やruntime queueから推測・backfillしません。

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
- ledgerだけを削除するとremoteへ再送されます。全再構築は新しいbackend namespaceとcron IDを組み合わせるか、backend namespaceと対応markerを一緒にresetしてください。
- groupは設定順、group内はsource entry追加順に走査します。batch数はremote成功turn数を制限しますが、履歴の走査量を制限するcursor stateは持ちません。大きな履歴や先頭groupの継続的な大量流入では走査コスト・後続groupの遅延が増えます。
- 通常queue/cronと同じ単一host process・Discord readinessの起動条件を引き継ぎます。Memory専用schedulerやmulti-host lockはありません。
- queue状態は [runtime-dbスキル](../.pi/skills/runtime-db/SKILL.md) のread-only手順で確認します。`cronJobId` / `jobKind` と通常のjob statusを使い、成功件数はledgerをread-onlyで確認します。runtime backupにsession DB・export ledgerは含まれません（[storage.md](storage.md)）。

### 旧capture経路からのrollout

旧shadow job互換実行・payload migrationはありません。**更新前に旧runtimeで未完了shadow jobをdrainし、queueに残っていないことをread-onlyで確認してから停止**してください。drainできない場合はrolloutを止め、既存queueの運用手順で対処します。ad-hocなSQL更新でleaseやdelivery状態を改変しないでください。

旧top-level `config/config.json.agentMemory` を削除し、必要なbackendを `config/cron.json` に移してrestartします。旧設定は新runtimeでは参照されません。新provenanceが保存される以降の会話が対象となり、既存remote memoryはそのまま保持できます。新経路のqueue、session、ledgerを確認してから通常運用へ戻してください。
